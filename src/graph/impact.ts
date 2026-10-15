import type { XrayDb } from '../db/database.ts';
import type { ImpactedFile, ImpactNode, ImpactResponse } from '../shared/api-types.ts';
import { reach, type Direction } from './traverse.ts';

export const DEFAULT_IMPACT_DEPTH = 4;
export const DEFAULT_RELATIONS = ['calls', 'imports'];

export interface ImpactOptions {
  /** upstream (default): what depends on the seeds, i.e. what a change could break. */
  direction?: Direction | 'both';
  maxDepth?: number;
  relations?: string[];
  /** Also start from everything inside the seeds (default true). */
  expandSeeds?: boolean;
}

/**
 * Blast radius of `seeds`: every node within `maxDepth` hops, grouped by file.
 * The seeds themselves (and anything inside them) are not part of the result.
 */
export function blastRadius(db: XrayDb, seeds: string[], options: ImpactOptions = {}): ImpactResponse {
  const maxDepth = options.maxDepth ?? DEFAULT_IMPACT_DEPTH;
  const relations = options.relations ?? DEFAULT_RELATIONS;
  const directions: Direction[] = options.direction === 'both' ? ['upstream', 'downstream'] : [options.direction ?? 'upstream'];
  const expandSeeds = options.expandSeeds ?? true;

  const nodes = new Map<string, ImpactNode>();
  const edges = new Set<number>();
  for (const direction of directions) {
    const result = reach(db, seeds, { direction, maxDepth, relations, expandSeeds });
    for (const [id, depth] of result.depths) {
      if (depth === 0) continue;
      const known = nodes.get(id);
      if (!known || depth < known.depth) nodes.set(id, { id, depth, direction });
    }
    for (const edge of result.edges) edges.add(edge.id);
  }
  // A seed reached from another seed is still a seed, not a casualty.
  for (const [id, depth] of reach(db, seeds, { direction: 'upstream', maxDepth: 0, relations, expandSeeds }).depths) {
    if (depth === 0) nodes.delete(id);
  }

  const rows = db
    .prepare(
      `SELECT n.id, n.layer, n.path, f.parent_id AS cluster
       FROM nodes n LEFT JOIN nodes f ON f.layer = 'file' AND f.path = n.path
       WHERE n.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...nodes.keys()])) as { id: string; layer: string; path: string | null; cluster: string | null }[];

  const files = new Map<string, ImpactedFile>();
  const clusters = new Set<string>();
  let symbols = 0;
  let externals = 0;
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.layer === 'symbol') symbols++;
    if (row.layer === 'external') externals++;
    if (row.cluster) clusters.add(row.cluster);
    if (!row.path) continue;
    const file = files.get(row.path) ?? { path: row.path, depth: node.depth, nodeIds: [] };
    file.depth = Math.min(file.depth, node.depth);
    file.nodeIds.push(row.id);
    files.set(row.path, file);
  }
  for (const file of files.values()) file.nodeIds.sort();

  return {
    seeds,
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
    edges: [...edges].sort((a, b) => a - b),
    files: [...files.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
    summary: { symbols, files: files.size, clusters: clusters.size, externals },
  };
}
