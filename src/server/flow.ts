import type { XrayDb } from '../db/database.ts';
import { blastRadius, DEFAULT_IMPACT_DEPTH, DEFAULT_RELATIONS } from '../graph/impact.ts';
import { traceQuestion } from '../graph/question.ts';
import { reach, shortestPaths } from '../graph/traverse.ts';
import type { FlowRequest, FlowResponse, ImpactRequest, ImpactResponse } from '../shared/api-types.ts';
import { getNode } from './queries.ts';

const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_QUESTION_DEPTH = 5;
const MAX_DEPTH_LIMIT = 20;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

export class FlowRequestError extends Error {}

/**
 * Deterministic flow tracing over the evidence graph, three ways:
 * - `from` + `to`: the shortest paths between them;
 * - `from` alone: everything downstream of it;
 * - `question`: entry points matched by name, then everything downstream.
 * `from` and `to` may be any layer; a file or cluster stands for everything inside it.
 */
export function traceFlow(db: XrayDb, request: FlowRequest): FlowResponse {
  checkObject(request);
  const limit = Math.min(positiveInt(request.limit, 'limit') ?? DEFAULT_LIMIT, MAX_LIMIT);
  const relations = stringArray(request.relations, 'relations');

  if (request.question !== undefined) {
    if (typeof request.question !== 'string' || request.question.trim() === '') {
      throw new FlowRequestError('`question` must be a non-empty string');
    }
    const maxDepth = depth(request.maxDepth, DEFAULT_QUESTION_DEPTH);
    const trace = traceQuestion(db, request.question, { maxDepth, relations: relations ?? ['calls'] });
    if (trace.keywords.length === 0) throw new FlowRequestError('The question has no searchable words');
    return {
      from: null,
      to: null,
      paths: [],
      reachable: { nodes: [...trace.depths.keys()], edges: trace.edges },
      question: { keywords: trace.keywords, matches: trace.matches, entryPoints: trace.entryPoints },
    };
  }

  const from = nodeId(request.from, 'from');
  const to = request.to === undefined ? undefined : nodeId(request.to, 'to');
  getNode(db, from);
  if (to) getNode(db, to);
  const options = { maxDepth: depth(request.maxDepth, DEFAULT_MAX_DEPTH), relations: relations ?? DEFAULT_RELATIONS };

  if (!to) {
    const downstream = reach(db, [from], { ...options, direction: 'downstream' });
    return {
      from,
      to: null,
      paths: [],
      reachable: { nodes: [...downstream.depths.keys()], edges: downstream.edges.map((edge) => edge.id) },
    };
  }
  return { from, to, paths: shortestPaths(db, from, to, { ...options, limit }).paths, reachable: null };
}

/** POST /api/impact: what depends on the given nodes (or what they depend on). */
export function traceImpact(db: XrayDb, request: ImpactRequest): ImpactResponse {
  checkObject(request);
  if (!Array.isArray(request.ids) || request.ids.length === 0 || request.ids.some((id) => typeof id !== 'string')) {
    throw new FlowRequestError('`ids` must be a non-empty array of node ids');
  }
  if (request.direction !== undefined && !['upstream', 'downstream', 'both'].includes(request.direction)) {
    throw new FlowRequestError('`direction` must be upstream, downstream or both');
  }
  for (const id of request.ids) getNode(db, id);
  return blastRadius(db, request.ids, {
    direction: request.direction,
    maxDepth: depth(request.maxDepth, DEFAULT_IMPACT_DEPTH),
    relations: stringArray(request.relations, 'relations') ?? DEFAULT_RELATIONS,
  });
}

function checkObject(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FlowRequestError('Body must be a JSON object');
}

function nodeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new FlowRequestError(`\`${field}\` must be a node id`);
  return value;
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new FlowRequestError(`\`${field}\` must be a positive integer`);
  return value as number;
}

function depth(value: unknown, fallback: number): number {
  return Math.min(positiveInt(value, 'maxDepth') ?? fallback, MAX_DEPTH_LIMIT);
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new FlowRequestError(`\`${field}\` must be an array of strings`);
  }
  return value as string[];
}
