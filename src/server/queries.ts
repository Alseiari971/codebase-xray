import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { getMeta, type XrayDb } from '../db/database.ts';
import type {
  EdgeEvidenceResponse,
  GraphEdge,
  GraphNode,
  GraphResponse,
  NodeEvidenceResponse,
  ResolutionType,
  Snippet,
} from '../shared/api-types.ts';

/** Lines shown around a cited range. */
const CONTEXT_LINES = 2;
/** A whole file is shown up to this many lines. */
const MAX_SNIPPET_LINES = 400;
const MAX_SNIPPETS = 20;

interface NodeRow {
  id: string;
  parent_id: string | null;
  layer: GraphNode['layer'];
  type: string;
  name: string;
  path: string | null;
  symbol: string | null;
  language: string | null;
  start_line: number | null;
  end_line: number | null;
  metadata: string;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  relation: string;
  resolution_type: ResolutionType;
  confidence: number;
  metadata: string;
}

interface EvidenceRow {
  edge_id: number;
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  rule: string;
  excerpt_hash: string | null;
}

export class NotFoundError extends Error {}

const NODE_COLUMNS = 'id, parent_id, layer, type, name, path, symbol, language, start_line, end_line, metadata';

export function toGraphNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    layer: row.layer,
    type: row.type,
    name: row.name,
    path: row.path,
    symbol: row.symbol,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function toGraphEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    relation: row.relation,
    resolutionType: row.resolution_type,
    confidence: row.confidence,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export function getGraph(db: XrayDb, root: string): GraphResponse {
  const nodes = (db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY id`).all() as NodeRow[]).map(toGraphNode);
  const edges = (db.prepare('SELECT * FROM edges ORDER BY id').all() as EdgeRow[]).map(toGraphEdge);
  return { root, indexedAt: getMeta(db, 'indexed_at') ?? null, nodes, edges };
}

export function getNode(db: XrayDb, id: string): GraphNode {
  const row = db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined;
  if (!row) throw new NotFoundError(`No node with id ${id}`);
  return toGraphNode(row);
}

/**
 * The source behind a node: a symbol's own lines, a file's contents, or for an
 * external package the lines that import it. Clusters have no source of their own.
 */
export function getNodeEvidence(db: XrayDb, root: string, id: string): NodeEvidenceResponse {
  const node = getNode(db, id);
  const files = new SourceFiles(db, root);
  const snippets: Snippet[] = [];

  if (node.layer === 'symbol' && node.path && node.startLine && node.endLine) {
    const snippet = files.snippet(node.path, node.startLine, node.endLine, null);
    if (snippet) snippets.push(snippet);
  } else if (node.layer === 'file' && node.path) {
    const snippet = files.snippet(node.path, 1, Number.MAX_SAFE_INTEGER, null);
    if (snippet) snippets.push(snippet);
  } else if (node.layer === 'external') {
    const rows = db
      .prepare(
        `SELECT ee.edge_id, v.* FROM edges e
         JOIN edge_evidence ee ON ee.edge_id = e.id
         JOIN evidence v ON v.id = ee.evidence_id
         WHERE e.target = ? AND e.relation = 'imports'
         ORDER BY v.file_path, v.start_line LIMIT ?`,
      )
      .all(id, MAX_SNIPPETS) as EvidenceRow[];
    for (const row of rows) {
      const snippet = files.evidenceSnippet(row);
      if (snippet) snippets.push(snippet);
    }
  }
  return { node, snippets };
}

export function getEdgeEvidence(db: XrayDb, root: string, id: number): EdgeEvidenceResponse {
  const row = db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
  if (!row) throw new NotFoundError(`No edge with id ${id}`);
  const files = new SourceFiles(db, root);
  const evidence = db
    .prepare(
      `SELECT ee.edge_id, v.* FROM edge_evidence ee JOIN evidence v ON v.id = ee.evidence_id
       WHERE ee.edge_id = ? ORDER BY v.start_line LIMIT ?`,
    )
    .all(id, MAX_SNIPPETS) as EvidenceRow[];
  const snippets = evidence.map((item) => files.evidenceSnippet(item)).filter((snippet) => snippet !== undefined);
  return { edge: toGraphEdge(row), snippets };
}

/** Reads repository files once per request and checks them against the index. */
class SourceFiles {
  private readonly cache = new Map<string, { lines: string[]; hash: string } | null>();

  constructor(
    private readonly db: XrayDb,
    private readonly root: string,
  ) {}

  evidenceSnippet(row: EvidenceRow): Snippet | undefined {
    const snippet = this.snippet(row.file_path, row.start_line, row.end_line, row.rule);
    if (!snippet) return undefined;
    const file = this.read(row.file_path)!;
    const excerpt = file.lines.slice(row.start_line - 1, row.end_line).join('\n');
    const excerptMatches = row.excerpt_hash === createHash('sha256').update(excerpt).digest('hex');
    return { ...snippet, stale: snippet.stale && !excerptMatches, edgeId: row.edge_id, evidenceId: row.id };
  }

  snippet(path: string, startLine: number, endLine: number, rule: string | null): Snippet | undefined {
    const file = this.read(path);
    if (!file) return undefined;

    const wholeFile = startLine === 1 && endLine >= file.lines.length;
    const last = Math.min(endLine, file.lines.length);
    const from = wholeFile ? 1 : Math.max(1, startLine - CONTEXT_LINES);
    const to = Math.min(wholeFile ? last : last + CONTEXT_LINES, from + MAX_SNIPPET_LINES - 1);
    const indexedHash = this.db
      .prepare("SELECT content_hash FROM nodes WHERE layer = 'file' AND path = ?")
      .pluck()
      .get(path) as string | undefined;

    return {
      filePath: path,
      startLine,
      endLine: last,
      rule,
      lines: file.lines.slice(from - 1, to).map((text, i) => ({ number: from + i, text })),
      truncated: to < (wholeFile ? last : last + CONTEXT_LINES),
      stale: indexedHash !== undefined && indexedHash !== file.hash,
    };
  }

  private read(path: string): { lines: string[]; hash: string } | undefined {
    if (!this.cache.has(path)) this.cache.set(path, this.load(path));
    return this.cache.get(path) ?? undefined;
  }

  private load(path: string): { lines: string[]; hash: string } | null {
    // Paths come from the index, but never read outside the repository.
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute)) return null;
    const content = readFileSync(absolute);
    const lines = content.toString('utf8').split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop(); // trailing newline is not a line
    return { lines, hash: createHash('sha256').update(content).digest('hex') };
  }
}
