// The local HTTP/JSON contract (blueprint section 16). Shared by the server
// and the web client, so the browser never depends on backend internals.

export type Layer = 'cluster' | 'file' | 'symbol' | 'datastore' | 'external';
export type ResolutionType = 'deterministic' | 'heuristic' | 'runtime_observed' | 'ai_inferred';

export interface GraphNode {
  id: string;
  parentId: string | null;
  layer: Layer;
  type: string;
  name: string;
  path: string | null;
  symbol: string | null;
  language: string | null;
  startLine: number | null;
  endLine: number | null;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: number;
  source: string;
  target: string;
  relation: string;
  resolutionType: ResolutionType;
  confidence: number;
  metadata: Record<string, unknown>;
}

/** GET /api/graph */
export interface GraphResponse {
  root: string;
  indexedAt: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SnippetLine {
  number: number;
  text: string;
}

export interface Snippet {
  filePath: string;
  /** The cited range; `lines` may include a little context around it. */
  startLine: number;
  endLine: number;
  /** Parser rule for edge evidence, null for a node's own source range. */
  rule: string | null;
  lines: SnippetLine[];
  truncated: boolean;
  /** The file changed since it was indexed, so the cited lines may have moved. */
  stale: boolean;
  /** For node evidence built from edges (e.g. who imports a package). */
  edgeId?: number;
  /** Row id in the evidence table; the same id MCP tools return. */
  evidenceId?: number;
}

/** GET /api/node/:id/evidence */
export interface NodeEvidenceResponse {
  node: GraphNode;
  snippets: Snippet[];
}

/** GET /api/edge/:id/evidence */
export interface EdgeEvidenceResponse {
  edge: GraphEdge;
  snippets: Snippet[];
}

/**
 * POST /api/flow. Send either `from` (and optionally `to`), or a `question`
 * such as "How does checkout work?".
 */
export interface FlowRequest {
  from?: string;
  /** Omit to get everything reachable downstream of `from`. */
  to?: string;
  /** Traced from the symbols whose names match its keywords. Default relations: ['calls']. */
  question?: string;
  /** Default 8, at most 20. */
  maxDepth?: number;
  /** Default ['calls', 'imports']. */
  relations?: string[];
  /** Maximum number of shortest paths to return. Default 5. */
  limit?: number;
}

export interface FlowPath {
  nodes: string[];
  edges: number[];
}

export interface FlowResponse {
  from: string | null;
  to: string | null;
  /** Shortest paths from `from` (or anything inside it) to `to` (or anything inside it). */
  paths: FlowPath[];
  /** When `to` is omitted, or for a question: everything reachable within maxDepth. */
  reachable: FlowPath | null;
  /** Only for a question. */
  question?: QuestionMatch;
}

export interface QuestionMatch {
  keywords: string[];
  /** Nodes whose names matched, best first. */
  matches: string[];
  /** The most upstream matches; `reachable` is traced from these. */
  entryPoints: string[];
}

/** POST /api/impact */
export interface ImpactRequest {
  ids: string[];
  /** upstream (default): what depends on `ids`, i.e. what a change could break. */
  direction?: 'upstream' | 'downstream' | 'both';
  /** Default 4, at most 20. */
  maxDepth?: number;
  /** Default ['calls', 'imports']. */
  relations?: string[];
}

export interface ImpactNode {
  id: string;
  /** Hops from the nearest seed. */
  depth: number;
  direction: 'upstream' | 'downstream';
}

export interface ImpactedFile {
  path: string;
  depth: number;
  nodeIds: string[];
}

export interface ImpactResponse {
  seeds: string[];
  /** Excludes the seeds and anything inside them. */
  nodes: ImpactNode[];
  edges: number[];
  files: ImpactedFile[];
  summary: { symbols: number; files: number; clusters: number; externals: number };
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  hunks: DiffHunk[];
  /** The file's node, if it is in the index. */
  nodeId: string | null;
  /** Indexed symbols whose line ranges overlap a changed hunk. */
  symbolIds: string[];
  /** The file differs from what was indexed, so symbol mapping may be off. */
  indexStale: boolean;
}

/** GET /api/diff */
export interface DiffResponse {
  isRepo: boolean;
  base: string;
  files: ChangedFile[];
  /** Every changed file and symbol node id (flagged `git-changed`). */
  nodeIds: string[];
  /** What depends on the changed code: callers and importers that could break. */
  impact: ImpactResponse;
}

export interface ApiError {
  error: string;
}
