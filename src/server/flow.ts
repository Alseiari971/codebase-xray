import type { XrayDb } from '../db/database.ts';
import type { FlowPath, FlowRequest, FlowResponse } from '../shared/api-types.ts';
import { getNode } from './queries.ts';

const DEFAULT_MAX_DEPTH = 8;
const MAX_DEPTH_LIMIT = 20;
const DEFAULT_RELATIONS = ['calls', 'imports'];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

export class FlowRequestError extends Error {}

interface Step {
  node: string;
  edge: number;
}

/**
 * Deterministic flow tracing over the evidence graph.
 *
 * `from` and `to` may be any layer: tracing from a file starts at the file and
 * every symbol inside it, so "src/api/routes.ts -> bcrypt" finds the path
 * through the functions that actually make the calls.
 */
export function traceFlow(db: XrayDb, request: FlowRequest): FlowResponse {
  const { from, to } = validate(request);
  getNode(db, from);
  if (to) getNode(db, to);

  const maxDepth = Math.min(request.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_LIMIT);
  const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const relations = request.relations ?? DEFAULT_RELATIONS;

  const outgoing = new Map<string, Step[]>();
  const edges = db
    .prepare('SELECT id, source, target FROM edges WHERE relation IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(relations)) as { id: number; source: string; target: string }[];
  for (const edge of edges) {
    const steps = outgoing.get(edge.source) ?? [];
    steps.push({ node: edge.target, edge: edge.id });
    outgoing.set(edge.source, steps);
  }

  const sources = subtree(db, from);
  const targets = to ? new Set(subtree(db, to)) : null;

  // Breadth-first from every source at once, remembering every shortest way
  // into each node so all equally short paths can be listed.
  const depth = new Map<string, number>(sources.map((node) => [node, 0]));
  const via = new Map<string, Step[]>();
  const reachedEdges = new Set<number>();
  let frontier = sources;
  let found = targets ? sources.filter((node) => targets.has(node)) : [];

  for (let level = 1; level <= maxDepth && frontier.length > 0 && found.length === 0; level++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const step of outgoing.get(node) ?? []) {
        const known = depth.get(step.node);
        if (known !== undefined && known < level) continue;
        if (known === undefined) {
          depth.set(step.node, level);
          next.push(step.node);
        }
        via.set(step.node, [...(via.get(step.node) ?? []), { node, edge: step.edge }]);
        reachedEdges.add(step.edge);
      }
    }
    frontier = next;
    if (targets) found = next.filter((node) => targets.has(node));
  }

  if (!targets) {
    return { from, to: null, paths: [], reachable: { nodes: [...depth.keys()], edges: [...reachedEdges] } };
  }

  const paths: FlowPath[] = [];
  for (const target of found.sort()) {
    for (const path of pathsInto(target, via, depth, limit - paths.length)) paths.push(path);
    if (paths.length >= limit) break;
  }
  return { from, to: to ?? null, paths, reachable: null };
}

function validate(request: FlowRequest): { from: string; to: string | undefined } {
  if (typeof request !== 'object' || request === null) throw new FlowRequestError('Body must be a JSON object');
  if (typeof request.from !== 'string' || request.from === '') throw new FlowRequestError('`from` must be a node id');
  if (request.to !== undefined && (typeof request.to !== 'string' || request.to === '')) {
    throw new FlowRequestError('`to` must be a node id');
  }
  for (const field of ['maxDepth', 'limit'] as const) {
    const value = request[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new FlowRequestError(`\`${field}\` must be a positive integer`);
    }
  }
  if (request.relations !== undefined && (!Array.isArray(request.relations) || request.relations.some((r) => typeof r !== 'string'))) {
    throw new FlowRequestError('`relations` must be an array of strings');
  }
  return { from: request.from, to: request.to };
}

/** A node and everything nested under it (cluster -> files -> symbols -> members). */
function subtree(db: XrayDb, id: string): string[] {
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN tree t ON n.parent_id = t.id
       ) SELECT id FROM tree`,
    )
    .pluck()
    .all(id) as string[];
}

/** Walks the shortest-path links backwards from `target`. */
function pathsInto(target: string, via: Map<string, Step[]>, depth: Map<string, number>, limit: number): FlowPath[] {
  const results: FlowPath[] = [];
  const walk = (node: string, nodes: string[], edges: number[]) => {
    if (results.length >= limit) return;
    if (depth.get(node) === 0) {
      results.push({ nodes: [node, ...nodes], edges });
      return;
    }
    for (const step of via.get(node) ?? []) {
      if (depth.get(step.node) === depth.get(node)! - 1) walk(step.node, [node, ...nodes], [step.edge, ...edges]);
    }
  };
  walk(target, [], []);
  return results;
}
