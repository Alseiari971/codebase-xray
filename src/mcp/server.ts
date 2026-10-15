// Read-only MCP server over the evidence graph (blueprint sections 6 and 9).
// Every tool is a thin wrapper around the same SQLite queries the web UI and
// the CLI use, so an agent sees the same node, edge and evidence ids a human
// sees in the browser.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XrayDb } from '../db/database.ts';
import { DEFAULT_DIFF_IMPACT_DEPTH, getDiff } from '../git/diff.ts';
import { architecture } from '../graph/architecture.ts';
import { blastRadius, DEFAULT_IMPACT_DEPTH } from '../graph/impact.ts';
import { resolveTarget } from '../graph/resolve.ts';
import { indexRepository } from '../indexer/indexer.ts';
import { traceFlow } from '../server/flow.ts';
import { getEdgeEvidence, getNodeEvidence } from '../server/queries.ts';
import type { Snippet } from '../shared/api-types.ts';

export interface McpOptions {
  db: XrayDb;
  root: string;
  /** Re-index changed files before a tool runs, at most this often (ms). 0 disables. Default 3000. */
  refreshIntervalMs?: number;
  version?: string;
}

const MAX_EDGES = 200;
const MAX_EVIDENCE_PER_EDGE = 3;
const MAX_NODE_EDGES = 25;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const INSTRUCTIONS = `Codebase X-Ray: a deterministic evidence graph of this repository (files, symbols, imports, calls), built from the TypeScript compiler, not guessed.

Ids are shared with the X-Ray web UI and HTTP API:
- nodes: cluster:<folder>, file:<path>, sym:<path>#<Name or Class.method>, ext:npm:<pkg>, ext:node:<module>
- edges and evidence: numeric ids; every edge cites evidence (file, line range, parser rule).

Suggested use: get_architecture_clusters to orient; trace_flow to see how a feature works; get_node_evidence to read the exact source behind a node or edge; get_blast_radius before changing something; get_changed_nodes after editing, to review what your change touches before committing. Cite node, edge and evidence ids in your answers so a human can check them in the UI.

resolutionType "deterministic" means the type checker proved the relationship; "heuristic" (e.g. a call through an interface) means it is likely but not proven.`;

export function createMcpServer(options: McpOptions): McpServer {
  const { db, root } = options;
  const refreshInterval = options.refreshIntervalMs ?? 3000;
  let lastRefresh = 0;

  /** Keeps the graph in step with the working tree, so answers match the code the agent just edited. */
  const refresh = () => {
    if (refreshInterval <= 0 || Date.now() - lastRefresh < refreshInterval) return;
    indexRepository(db, root);
    lastRefresh = Date.now();
  };

  const server = new McpServer({ name: 'codebase-xray', version: options.version ?? '0.0.0' }, { instructions: INSTRUCTIONS });

  const tool = <T>(run: (args: T) => unknown) => async (args: T): Promise<CallToolResult> => {
    try {
      refresh();
      // Compact JSON without nulls: agents read it fine and it saves their context.
      return { content: [{ type: 'text', text: JSON.stringify(run(args), (_key, value: unknown) => (value === null ? undefined : value)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  };

  server.registerTool(
    'get_architecture_clusters',
    {
      title: 'Architecture clusters',
      description:
        'The repository at a glance: its folder clusters with file and symbol counts, their largest files, ' +
        'which clusters depend on which (by imports and calls), and the external packages each uses.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(() => architecture(db)),
  );

  server.registerTool(
    'trace_flow',
    {
      title: 'Trace a flow',
      description:
        'Trace how a feature works. Pass `question` (e.g. "how does checkout work?") to start from the symbols ' +
        'its words name and follow their calls downstream. Or pass `from` (and optionally `to`) node ids, file ' +
        'paths or symbol names for the shortest paths between them, or everything downstream of `from`. ' +
        'Returns nodes, edges with ids, resolution types and evidence, and the entry points used.',
      inputSchema: {
        question: z.string().optional().describe('A natural question, e.g. "how does login work?"'),
        from: z.string().optional().describe('Start: node id, repository file path, or symbol name'),
        to: z.string().optional().describe('Target: node id, repository file path, or symbol name'),
        maxDepth: z.number().int().min(1).max(20).optional().describe('Hops to follow (default 5 for a question, 8 otherwise)'),
        relations: z.array(z.enum(['calls', 'imports'])).optional().describe('Edges to follow'),
      },
      annotations: READ_ONLY,
    },
    tool((args: { question?: string; from?: string; to?: string; maxDepth?: number; relations?: string[] }) => {
      const result = traceFlow(db, {
        question: args.question,
        from: args.from === undefined ? undefined : resolveTarget(db, args.from),
        to: args.to === undefined ? undefined : resolveTarget(db, args.to),
        maxDepth: args.maxDepth,
        relations: args.relations,
      });
      const edgeIds = result.reachable?.edges ?? [...new Set(result.paths.flatMap((path) => path.edges))];
      const nodeIds = result.reachable?.nodes ?? [...new Set(result.paths.flatMap((path) => path.nodes))];
      return {
        ...(result.question ? { question: result.question } : { from: result.from, to: result.to }),
        ...(result.paths.length > 0 || result.to ? { paths: result.paths } : {}),
        nodes: describeNodes(db, nodeIds),
        edges: describeEdges(db, edgeIds.slice(0, MAX_EDGES)),
        ...(edgeIds.length > MAX_EDGES ? { truncatedEdges: edgeIds.length - MAX_EDGES } : {}),
      };
    }),
  );

  server.registerTool(
    'get_blast_radius',
    {
      title: 'Blast radius',
      description:
        'What could break if `target` changes: everything that calls or imports it (upstream), within maxDepth ' +
        'hops, grouped by file. Use direction "downstream" for what it depends on instead.',
      inputSchema: {
        target: z.string().describe('Node id, repository file path, or symbol name'),
        direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('Default upstream'),
        maxDepth: z.number().int().min(1).max(20).optional().describe(`Default ${DEFAULT_IMPACT_DEPTH}`),
      },
      annotations: READ_ONLY,
    },
    tool((args: { target: string; direction?: 'upstream' | 'downstream' | 'both'; maxDepth?: number }) => {
      const id = resolveTarget(db, args.target);
      const result = blastRadius(db, [id], { direction: args.direction, maxDepth: args.maxDepth });
      const nodes = new Map(describeNodes(db, result.nodes.map((node) => node.id)).map((node) => [node.id, node]));
      return {
        target: describeNodes(db, [id])[0],
        summary: result.summary,
        files: result.files.map((file) => ({
          path: file.path,
          depth: file.depth,
          nodes: file.nodeIds.map((nodeId) => ({ ...nodes.get(nodeId)!, depth: result.nodes.find((n) => n.id === nodeId)!.depth })),
        })),
        externals: result.nodes.filter((node) => nodes.get(node.id)?.layer === 'external').map((node) => node.id),
        edges: result.edges,
      };
    }),
  );

  server.registerTool(
    'get_node_evidence',
    {
      title: 'Node or edge evidence',
      description:
        'The exact source behind a node (its lines, read from disk now, with line numbers) and its incoming and ' +
        'outgoing edges, each with evidence ids and cited lines. Pass `edgeId` instead to get every piece of ' +
        'evidence behind one edge. Snippets marked stale changed since indexing.',
      inputSchema: {
        target: z.string().optional().describe('Node id, repository file path, or symbol name'),
        edgeId: z.number().int().optional().describe('An edge id from another tool'),
      },
      annotations: READ_ONLY,
    },
    tool((args: { target?: string; edgeId?: number }) => {
      if (args.edgeId !== undefined) {
        const { edge, snippets } = getEdgeEvidence(db, root, args.edgeId);
        return { edge: { ...edge, source: describeNodes(db, [edge.source])[0], target: describeNodes(db, [edge.target])[0] }, evidence: snippets.map(formatSnippet) };
      }
      if (args.target === undefined) throw new Error('Pass `target` or `edgeId`');
      const { node, snippets } = getNodeEvidence(db, root, resolveTarget(db, args.target));
      const edges = (side: 'source' | 'target') =>
        describeEdges(
          db,
          db
            .prepare(`SELECT id FROM edges WHERE ${side} = ? ORDER BY relation, id LIMIT ?`)
            .pluck()
            .all(node.id, MAX_NODE_EDGES) as number[],
        );
      return {
        node: { ...describeNodes(db, [node.id])[0], metadata: node.metadata },
        source: snippets.map(formatSnippet),
        children: (db.prepare('SELECT id FROM nodes WHERE parent_id = ? ORDER BY start_line, id LIMIT 50').pluck().all(node.id) as string[]),
        outgoing: edges('source'),
        incoming: edges('target'),
      };
    }),
  );

  server.registerTool(
    'get_changed_nodes',
    {
      title: 'Changed nodes',
      description:
        'Uncommitted changes (staged, unstaged and untracked) against `base`, mapped to the files and symbols ' +
        'whose lines they touch (flagged git-changed), plus their blast radius: callers and importers that could ' +
        'break. Use it to review an edit before committing.',
      inputSchema: {
        base: z.string().optional().describe('Git ref to compare with (default HEAD)'),
        impactDepth: z.number().int().min(1).max(20).optional().describe(`Default ${DEFAULT_DIFF_IMPACT_DEPTH}`),
      },
      annotations: READ_ONLY,
    },
    tool((args: { base?: string; impactDepth?: number }) => {
      const diff = getDiff(db, root, args.base ?? 'HEAD', { impactDepth: args.impactDepth });
      if (!diff.isRepo) return { isRepo: false, files: [], impact: null };
      const symbols = new Map(describeNodes(db, diff.files.flatMap((file) => file.symbolIds)).map((node) => [node.id, node]));
      const impacted = new Map(describeNodes(db, diff.impact.nodes.map((node) => node.id)).map((node) => [node.id, node]));
      return {
        isRepo: true,
        base: diff.base,
        files: diff.files.map((file) => ({
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status,
          nodeId: file.nodeId,
          changedLines: file.hunks.map((hunk) =>
            hunk.newLines === 0
              ? `deleted after ${hunk.newStart}`
              : hunk.newLines === 1
                ? `${hunk.newStart}`
                : `${hunk.newStart}-${hunk.newStart + hunk.newLines - 1}`,
          ),
          symbols: file.symbolIds.map((id) => symbols.get(id)),
          indexStale: file.indexStale,
        })),
        impact: {
          summary: diff.impact.summary,
          nodes: diff.impact.nodes.map((node) => ({ ...impacted.get(node.id), depth: node.depth })),
          edges: diff.impact.edges,
        },
      };
    }),
  );

  return server;
}

interface NodeSummary {
  id: string;
  layer: string;
  type: string;
  name: string;
  path: string | null;
  lines: string | null;
}

/** Compact node descriptions, in the order asked for. */
function describeNodes(db: XrayDb, ids: string[]): NodeSummary[] {
  const rows = db
    .prepare('SELECT id, layer, type, name, symbol, path, start_line, end_line FROM nodes WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) as { id: string; layer: string; type: string; name: string; symbol: string | null; path: string | null; start_line: number | null; end_line: number | null }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [{
      id,
      layer: row.layer,
      type: row.type,
      name: row.symbol ?? row.name,
      path: row.path,
      lines: row.start_line ? `${row.start_line}-${row.end_line}` : null,
    }];
  });
}

/** Edges with their resolution and the first few pieces of evidence (id, file, lines, rule). */
function describeEdges(db: XrayDb, ids: number[]) {
  const edges = db
    .prepare('SELECT id, source, target, relation, resolution_type, confidence FROM edges WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(ids)) as { id: number; source: string; target: string; relation: string; resolution_type: string; confidence: number }[];
  const evidence = db.prepare(
    `SELECT v.id, v.file_path, v.start_line, v.end_line, v.rule FROM edge_evidence ee JOIN evidence v ON v.id = ee.evidence_id
     WHERE ee.edge_id = ? ORDER BY v.start_line LIMIT ?`,
  );
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    resolutionType: edge.resolution_type,
    confidence: edge.confidence,
    evidence: (evidence.all(edge.id, MAX_EVIDENCE_PER_EDGE) as { id: number; file_path: string; start_line: number; end_line: number; rule: string }[]).map((item) => ({
      id: item.id,
      at: `${item.file_path}:${item.start_line}${item.end_line !== item.start_line ? `-${item.end_line}` : ''}`,
      rule: item.rule,
    })),
  }));
}

/** A snippet as `path:lines` plus numbered source text. */
function formatSnippet(snippet: Snippet) {
  const width = String(snippet.lines.at(-1)?.number ?? 1).length;
  return {
    ...(snippet.evidenceId !== undefined ? { evidenceId: snippet.evidenceId } : {}),
    ...(snippet.edgeId !== undefined ? { edgeId: snippet.edgeId } : {}),
    at: `${snippet.filePath}:${snippet.startLine}${snippet.endLine !== snippet.startLine ? `-${snippet.endLine}` : ''}`,
    ...(snippet.rule ? { rule: snippet.rule } : {}),
    ...(snippet.stale ? { stale: true } : {}),
    ...(snippet.truncated ? { truncated: true } : {}),
    code: snippet.lines.map((line) => `${String(line.number).padStart(width)}| ${line.text}`).join('\n'),
  };
}
