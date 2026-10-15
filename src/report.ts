// Plain-text reports for the CLI (each returns lines so tests can read them),
// plus the exported architecture report and graph snapshot.

import { getMeta, type XrayDb } from './db/database.ts';
import { architecture, type Architecture } from './graph/architecture.ts';
import type { DiffResponse, ImpactResponse } from './shared/api-types.ts';

interface NodeInfo {
  id: string;
  layer: string;
  type: string;
  name: string;
  symbol: string | null;
  path: string | null;
  start_line: number | null;
}

export function describeNodes(db: XrayDb, ids: Iterable<string>): Map<string, NodeInfo> {
  const rows = db
    .prepare('SELECT id, layer, type, name, symbol, path, start_line FROM nodes WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...ids])) as NodeInfo[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** `login  src/auth/login.ts:9`, `bcrypt  (npm package)`, `src/api/server.js  (file)`. */
export function label(info: NodeInfo | undefined, id: string): string {
  if (!info) return id;
  if (info.layer === 'symbol') return `${info.symbol ?? info.name}  ${info.path}:${info.start_line}`;
  if (info.layer === 'file') return `${info.path}  (file)`;
  if (info.layer === 'external') return `${info.name}  (${info.type === 'builtin' ? 'node builtin' : 'npm package'})`;
  return `${info.name}  (${info.layer})`;
}

/**
 * Draws a traced flow as a tree from its entry points. A node reachable along
 * several branches is drawn once and referenced afterwards.
 */
export function flowTree(
  db: XrayDb,
  entryPoints: string[],
  edges: { source: string; target: string }[],
): string[] {
  const children = new Map<string, string[]>();
  for (const edge of edges) children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]);
  const info = describeNodes(db, [...entryPoints, ...edges.flatMap((edge) => [edge.source, edge.target])]);

  const lines: string[] = [];
  const drawn = new Set<string>();
  const draw = (id: string, prefix: string, connector: string) => {
    const seen = drawn.has(id);
    lines.push(`${prefix}${connector}${label(info.get(id), id)}${seen ? '  (see above)' : ''}`);
    if (seen) return;
    drawn.add(id);
    const kids = [...new Set(children.get(id) ?? [])].sort();
    const childPrefix = prefix + (connector === '' ? '' : connector === '└─ ' ? '   ' : '│  ');
    kids.forEach((kid, i) => draw(kid, childPrefix, i === kids.length - 1 ? '└─ ' : '├─ '));
  };
  for (const entry of entryPoints) draw(entry, '  ', '');
  return lines;
}

/** One line per affected file, nearest first, with the symbols in it. */
export function impactLines(db: XrayDb, impact: ImpactResponse, limit = 25): string[] {
  const info = describeNodes(db, impact.nodes.map((node) => node.id));
  const width = Math.max(0, ...impact.files.slice(0, limit).map((file) => file.path.length));
  const lines = impact.files.slice(0, limit).map((file) => {
    const symbols = file.nodeIds
      .map((id) => info.get(id))
      .filter((node) => node?.layer === 'symbol')
      .map((node) => node!.symbol ?? node!.name);
    return `  ${file.depth}  ${file.path.padEnd(width)}  ${symbols.length > 0 ? symbols.join(', ') : '(file-level)'}`;
  });
  if (impact.files.length > limit) lines.push(`  ...and ${impact.files.length - limit} more files`);
  const externals = impact.nodes.filter((node) => info.get(node.id)?.layer === 'external');
  for (const node of externals) lines.push(`  ${node.depth}  ${label(info.get(node.id), node.id)}`);
  return lines;
}

export function impactSummary(impact: ImpactResponse): string {
  const { symbols, files, clusters } = impact.summary;
  return `${symbols} ${plural(symbols, 'symbol')} in ${files} ${plural(files, 'file')} across ${clusters} ${plural(clusters, 'cluster')}`;
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: '?' } as const;

export function diffLines(db: XrayDb, diff: DiffResponse, impactDepth: number): string[] {
  if (diff.files.length === 0) return [`No uncommitted changes against ${diff.base}.`];

  const symbolCount = diff.files.reduce((sum, file) => sum + file.symbolIds.length, 0);
  const lines = [
    `${diff.files.length} ${plural(diff.files.length, 'file')} changed, ${symbolCount} ${plural(symbolCount, 'symbol')} touched (against ${diff.base}):`,
  ];
  for (const file of diff.files) {
    const from = file.oldPath ? ` (from ${file.oldPath})` : '';
    lines.push(`  ${STATUS_LETTER[file.status]} ${file.path}${from}${file.indexStale ? '  [index stale]' : ''}`);
    for (const id of file.symbolIds) lines.push(`      ${id.slice(id.indexOf('#') + 1)}`);
  }

  lines.push('');
  if (diff.impact.files.length === 0) {
    lines.push('Impact: nothing else in the index calls or imports the changed code.');
  } else {
    lines.push(`Impact: ${impactSummary(diff.impact)} call or import the changed code (up to ${impactDepth} hops):`);
    lines.push(...impactLines(db, diff.impact));
  }

  if (diff.files.some((file) => file.indexStale)) {
    lines.push('', 'Some files changed since the last index; run `xray index` for exact symbol mapping.');
  }
  return lines;
}

function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return count === 1 ? word : pluralWord;
}

export type ExportFormat = 'md' | 'json';

/**
 * The architecture report (`md`, README-ready, with a Mermaid diagram) or the
 * portable graph snapshot (`json`: nodes, edges, evidence). Both come straight
 * from the index; no AI is involved.
 */
export function exportReport(db: XrayDb, root: string, format: ExportFormat, now = new Date()): string {
  return format === 'json' ? JSON.stringify(graphSnapshot(db, root, now), null, 2) + '\n' : markdownReport(db, root, now);
}

/** Every node, edge and piece of evidence, with paths relative to the repository root. */
export function graphSnapshot(db: XrayDb, root: string, now = new Date()) {
  const nodes = (db.prepare('SELECT * FROM nodes ORDER BY id').all() as Record<string, unknown>[]).map((row) => ({
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
    contentHash: row.content_hash,
    metadata: JSON.parse(String(row.metadata)) as unknown,
  }));
  const evidenceByEdge = new Map<number, number[]>();
  const links = db.prepare('SELECT edge_id, evidence_id FROM edge_evidence ORDER BY edge_id, evidence_id').all() as { edge_id: number; evidence_id: number }[];
  for (const link of links) evidenceByEdge.set(link.edge_id, [...(evidenceByEdge.get(link.edge_id) ?? []), link.evidence_id]);
  const edges = (db.prepare('SELECT * FROM edges ORDER BY id').all() as Record<string, unknown>[]).map((row) => ({
    id: row.id,
    source: row.source,
    target: row.target,
    relation: row.relation,
    resolutionType: row.resolution_type,
    confidence: row.confidence,
    metadata: JSON.parse(String(row.metadata)) as unknown,
    evidence: evidenceByEdge.get(row.id as number) ?? [],
  }));
  const evidence = (db.prepare('SELECT * FROM evidence ORDER BY id').all() as Record<string, unknown>[]).map((row) => ({
    id: row.id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    rule: row.rule,
    excerptHash: row.excerpt_hash,
  }));
  return {
    format: 'codebase-xray/graph',
    version: 1,
    // The folder name only: absolute paths would leak the machine's layout.
    repository: basename(root),
    generatedAt: now.toISOString(),
    indexedAt: getMeta(db, 'indexed_at') ?? null,
    nodes,
    edges,
    evidence,
  };
}

const TEST_PATH = /(^|\/)(test|tests|__tests__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_LANGUAGES = new Set(['typescript', 'javascript']);

function markdownReport(db: XrayDb, root: string, now: Date): string {
  const arch = architecture(db);
  const count = (sql: string) => db.prepare(sql).pluck().get() as number;
  const imports = count("SELECT count(*) FROM edges WHERE relation = 'imports'");
  const calls = count("SELECT count(*) FROM edges WHERE relation = 'calls'");
  const heuristic = count("SELECT count(*) FROM edges WHERE resolution_type != 'deterministic'");
  const unresolved = count("SELECT coalesce(sum(json_array_length(metadata, '$.unresolvedImports')), 0) FROM nodes WHERE layer = 'file'");
  const out: string[] = [];

  out.push(`# Architecture of ${basename(root)}`, '');
  out.push(
    `_Generated by [Codebase X-Ray](https://github.com/Alseiari971/codebase-xray) on ${now.toISOString().slice(0, 10)} ` +
      'from the deterministic evidence graph (TypeScript compiler, no AI). Every relationship below is backed by source lines in the index._',
    '',
  );

  out.push('## Summary', '');
  out.push('| Files | Symbols | Clusters | Import edges | Call edges | External packages |', '| --- | --- | --- | --- | --- | --- |');
  out.push(`| ${arch.totals.files} | ${arch.totals.symbols} | ${arch.clusters.length} | ${imports} | ${calls} | ${arch.totals.externals} |`, '');
  const notes: string[] = [];
  if (heuristic > 0) {
    notes.push(`${heuristic} ${plural(heuristic, 'edge')} ${heuristic === 1 ? 'is' : 'are'} heuristic (for example, a call through an interface) rather than proven by the type checker.`);
  }
  if (unresolved > 0) notes.push(`${unresolved} ${plural(unresolved, 'import')} could not be resolved to a file in the repository.`);
  if (notes.length > 0) out.push(...notes.map((note) => `- ${note}`), '');

  // Mermaid node ids must be plain; labels are quoted and escaped.
  const mermaidId = new Map(arch.clusters.map((cluster, i) => [cluster.id, `c${i}`]));
  out.push('## Cluster dependencies', '');
  out.push('Arrows point from a cluster to the clusters it calls or imports; labels count the underlying edges.', '');
  out.push('```mermaid', 'graph TD');
  for (const cluster of arch.clusters) {
    out.push(`  ${mermaidId.get(cluster.id)}["${mermaidText(cluster.name)}<br/>${cluster.files} ${plural(cluster.files, 'file')} · ${cluster.symbols} ${plural(cluster.symbols, 'symbol')}"]`);
  }
  for (const cluster of arch.clusters) {
    for (const link of cluster.dependsOn) {
      const target = mermaidId.get(link.cluster);
      if (target) out.push(`  ${mermaidId.get(cluster.id)} -->|${link.edges}| ${target}`);
    }
  }
  out.push('```', '');

  out.push('## Clusters', '');
  for (const cluster of arch.clusters) {
    out.push(`### ${cluster.name}`, '');
    out.push(
      `${cluster.files} ${plural(cluster.files, 'file')}, ${cluster.symbols} ${plural(cluster.symbols, 'symbol')}, ` +
        `${cluster.internalEdges} internal ${plural(cluster.internalEdges, 'dependency', 'dependencies')}.`,
      '',
    );
    if (cluster.topFiles.length > 0) {
      out.push('| Largest files | Symbols |', '| --- | --- |');
      for (const file of cluster.topFiles) out.push(`| \`${file.path}\` | ${file.symbols} |`);
      out.push('');
    }
    const links = (list: { cluster: string; edges: number }[]) =>
      list.map((link) => `${clusterName(arch, link.cluster)} (${link.edges})`).join(', ');
    const facts: string[] = [];
    if (cluster.dependsOn.length > 0) facts.push(`- **Depends on:** ${links(cluster.dependsOn)}`);
    if (cluster.usedBy.length > 0) facts.push(`- **Used by:** ${links(cluster.usedBy)}`);
    if (cluster.externals.length > 0) {
      facts.push(`- **External packages:** ${cluster.externals.map((id) => `\`${id.replace(/^ext:(npm:)?/, '')}\``).join(', ')}`);
    }
    if (facts.length > 0) out.push(...facts, '');
  }

  out.push('## Entry points', '');
  out.push('Source files that nothing else in the repository imports or calls (tests excluded): where execution or outside consumers start.', '');
  const entries = entryPoints(db);
  if (entries.length === 0) {
    out.push('_None found: every source file is used by another._', '');
  } else {
    out.push('| File | Exports | Outgoing dependencies |', '| --- | --- | --- |');
    for (const entry of entries) {
      const shown = entry.exports.slice(0, 6).map((symbol) => `\`${symbol}\``).join(', ');
      const exports = entry.exports.length === 0 ? '–' : entry.exports.length > 6 ? `${shown}, …` : shown;
      out.push(`| \`${entry.path}\` | ${exports} | ${entry.uses} |`);
    }
    out.push('');
  }

  const hubs = db
    .prepare(
      `SELECT n.symbol, n.name, n.path, n.start_line, count(e.id) AS users
       FROM nodes n JOIN edges e ON e.target = n.id
       WHERE n.layer = 'symbol' GROUP BY n.id ORDER BY users DESC, n.id LIMIT 10`,
    )
    .all() as { symbol: string | null; name: string; path: string; start_line: number; users: number }[];
  if (hubs.length > 0) {
    out.push('## Most depended-on code', '');
    out.push('A change to these touches the most other code; `xray impact <name>` shows exactly what.', '');
    out.push('| Symbol | Location | Incoming edges |', '| --- | --- | --- |');
    for (const hub of hubs) out.push(`| \`${hub.symbol ?? hub.name}\` | \`${hub.path}:${hub.start_line}\` | ${hub.users} |`);
    out.push('');
  }

  const packages = db
    .prepare(
      `SELECT x.name, x.type, count(DISTINCT s.path) AS files
       FROM nodes x JOIN edges e ON e.target = x.id JOIN nodes s ON s.id = e.source
       WHERE x.layer = 'external' GROUP BY x.id ORDER BY files DESC, x.name`,
    )
    .all() as { name: string; type: string; files: number }[];
  if (packages.length > 0) {
    out.push('## External packages', '');
    out.push('| Package | Kind | Used in files |', '| --- | --- | --- |');
    for (const pkg of packages) out.push(`| \`${pkg.name}\` | ${pkg.type === 'builtin' ? 'Node builtin' : 'npm'} | ${pkg.files} |`);
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

/** Source files no other file imports or calls into, excluding tests. */
function entryPoints(db: XrayDb): { path: string; exports: string[]; uses: number }[] {
  const files = db
    .prepare(
      `SELECT f.path, f.language,
              (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
                 WHERE s.path = f.path AND t.path IS NOT f.path) AS uses
       FROM nodes f
       WHERE f.layer = 'file' AND NOT EXISTS (
         SELECT 1 FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE t.path = f.path AND s.path IS NOT f.path
       )
       ORDER BY f.path`,
    )
    .all() as { path: string; language: string; uses: number }[];
  const exportsOf = db
    .prepare(
      "SELECT coalesce(symbol, name) FROM nodes WHERE layer = 'symbol' AND path = ? AND parent_id = ? AND json_extract(metadata, '$.exported') = 1 ORDER BY start_line",
    )
    .pluck();
  return files
    .filter((file) => CODE_LANGUAGES.has(file.language) && !TEST_PATH.test(file.path) && !file.path.endsWith('.d.ts'))
    .map((file) => ({ path: file.path, exports: exportsOf.all(file.path, `file:${file.path}`) as string[], uses: file.uses }));
}

function clusterName(arch: Architecture, id: string): string {
  return arch.clusters.find((cluster) => cluster.id === id)?.name ?? id;
}

function mermaidText(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
