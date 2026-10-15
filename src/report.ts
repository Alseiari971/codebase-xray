// Plain-text reports for the CLI. Each returns lines so tests can read them.

import type { XrayDb } from './db/database.ts';
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

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
