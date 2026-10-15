// Node ids are readable and derived only from repository facts, so the same
// repository always produces the same ids. That keeps re-indexing incremental,
// JSON snapshots diffable, and MCP answers stable between runs.

export function fileNodeId(path: string): string {
  return `file:${path}`;
}

/** `qualifiedName` is `name` for top-level symbols and `Class.member` for members. */
export function symbolNodeId(path: string, qualifiedName: string): string {
  return `sym:${path}#${qualifiedName}`;
}

/** `prefix` is the folder the cluster stands for; '' is the repository root. */
export function clusterNodeId(prefix: string): string {
  return `cluster:${prefix}`;
}

export const OTHER_CLUSTER_ID = 'cluster:*';

/** npm packages are `npm:<name>`, Node builtins are `node:<name>`. */
export function externalNodeId(moduleName: string): string {
  return `ext:${moduleName}`;
}
