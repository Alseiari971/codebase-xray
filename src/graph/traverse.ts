// Deterministic graph traversal, done in SQLite with recursive CTEs so the
// browser, the CLI and (later) MCP tools all ask the database the same question.

import type { XrayDb } from '../db/database.ts';

export type Direction = 'downstream' | 'upstream';

export interface TraversalOptions {
  /** downstream: what the seeds depend on. upstream: what depends on the seeds. */
  direction: Direction;
  maxDepth: number;
  relations: string[];
  /** Start from everything inside the seeds too (default). Off for exact seeds such as changed symbols. */
  expandSeeds?: boolean;
}

export interface Reach {
  /** Every reached node with its distance from the nearest seed (seeds are 0). */
  depths: Map<string, number>;
  /** Edges that move exactly one step further from the seeds: the BFS layers. */
  edges: { id: number; source: string; target: string }[];
}

/**
 * The walk CTE. Seeds are expanded to their whole subtree first, so starting
 * from a file or cluster starts from every symbol inside it. `UNION` (not
 * `UNION ALL`) drops repeated (node, depth) rows, so cycles terminate at
 * maxDepth. Parameters: @seeds and @relations (JSON arrays) and @maxDepth.
 */
function walkCte(direction: Direction, expandSeeds: boolean): string {
  const [from, to] = direction === 'downstream' ? ['source', 'target'] : ['target', 'source'];
  const children = expandSeeds ? 'UNION SELECT n.id FROM nodes n JOIN seed_tree t ON n.parent_id = t.id' : '';
  return `
    WITH RECURSIVE
      seed_tree(id) AS (
        SELECT n.id FROM nodes n WHERE n.id IN (SELECT value FROM json_each(@seeds))
        ${children}
      ),
      walk(id, depth) AS (
        SELECT id, 0 FROM seed_tree
        UNION
        SELECT e.${to}, w.depth + 1
        FROM walk w JOIN edges e ON e.${from} = w.id
        WHERE w.depth < @maxDepth AND e.relation IN (SELECT value FROM json_each(@relations))
      ),
      reached(id, depth) AS (SELECT id, min(depth) FROM walk GROUP BY id)`;
}

export function reach(db: XrayDb, seeds: string[], options: TraversalOptions): Reach {
  const params = { seeds: JSON.stringify(seeds), relations: JSON.stringify(options.relations), maxDepth: options.maxDepth };
  const cte = walkCte(options.direction, options.expandSeeds ?? true);

  const rows = db.prepare(`${cte} SELECT id, depth FROM reached`).all(params) as { id: string; depth: number }[];

  const [near, far] = options.direction === 'downstream' ? ['s', 't'] : ['t', 's'];
  const edges = db
    .prepare(
      `${cte}
       SELECT e.id, e.source, e.target FROM edges e
       JOIN reached s ON s.id = e.source
       JOIN reached t ON t.id = e.target
       WHERE e.relation IN (SELECT value FROM json_each(@relations)) AND ${far}.depth = ${near}.depth + 1
       ORDER BY e.id`,
    )
    .all(params) as Reach['edges'];

  return { depths: new Map(rows.map((row) => [row.id, row.depth])), edges };
}

export interface ShortestPaths {
  paths: { nodes: string[]; edges: number[] }[];
}

/**
 * Shortest paths from `from` to `to` (either may be a container). Walks
 * downstream from `from` and upstream from `to`; the nodes where the two
 * distances add up to the minimum form the shortest-path DAG, which is small,
 * so listing its paths is cheap.
 */
export function shortestPaths(
  db: XrayDb,
  from: string,
  to: string,
  options: Omit<TraversalOptions, 'direction'> & { limit: number },
): ShortestPaths {
  const forward = reach(db, [from], { ...options, direction: 'downstream' });
  const backward = reach(db, [to], { ...options, direction: 'upstream' });

  let length = Infinity;
  for (const [id, down] of forward.depths) {
    const up = backward.depths.get(id);
    if (up !== undefined) length = Math.min(length, down + up);
  }
  if (length === Infinity || length > options.maxDepth) return { paths: [] };

  const onPath = (id: string) => (forward.depths.get(id) ?? Infinity) + (backward.depths.get(id) ?? Infinity) === length;
  const next = new Map<string, { node: string; edge: number }[]>();
  for (const edge of forward.edges) {
    if (onPath(edge.source) && onPath(edge.target)) {
      next.set(edge.source, [...(next.get(edge.source) ?? []), { node: edge.target, edge: edge.id }]);
    }
  }

  const paths: ShortestPaths['paths'] = [];
  const starts = [...forward.depths].filter(([id, depth]) => depth === 0 && onPath(id)).map(([id]) => id).sort();
  const walk = (node: string, nodes: string[], edges: number[]) => {
    if (paths.length >= options.limit) return;
    if (backward.depths.get(node) === 0) {
      paths.push({ nodes, edges });
      return;
    }
    for (const step of next.get(node) ?? []) walk(step.node, [...nodes, step.node], [...edges, step.edge]);
  };
  for (const start of starts) walk(start, [start], []);
  return { paths };
}

/** A node and everything nested under it (cluster -> files -> symbols -> members). */
export function subtree(db: XrayDb, id: string): string[] {
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION SELECT n.id FROM nodes n JOIN tree t ON n.parent_id = t.id
       ) SELECT id FROM tree`,
    )
    .pluck()
    .all(id) as string[];
}
