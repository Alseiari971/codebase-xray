import { clusterNodeId, OTHER_CLUSTER_ID } from '../graph/ids.ts';

export interface Cluster {
  id: string;
  name: string;
  /** Folder the cluster stands for; '' for root-level files, null for the overflow cluster. */
  prefix: string | null;
  files: string[];
}

export interface ClusterOptions {
  /** Keep splitting folders until there are at least this many clusters. */
  min?: number;
  /** Fold the smallest folders into one "other" cluster beyond this many. */
  max?: number;
}

interface Group {
  prefix: string;
  files: string[];
  /** False once a group only holds the files directly inside `prefix`. */
  splittable: boolean;
}

/** A group holding more than this share of all files is split even when there are already `min` groups. */
const DOMINANT_SHARE = 0.5;

/**
 * Groups files into a handful of domain clusters by folder (blueprint: "the
 * graph is never a chaotic hairball"). Starts from top-level folders and
 * splits the largest ones (`src` -> `src/auth`, `src/api`, ...) until there are
 * enough clusters and none dominates, then folds the smallest into "(other)".
 * A split is undone if "(other)" would end up as the largest cluster.
 */
export function clusterFiles(paths: string[], { min = 5, max = 10 }: ClusterOptions = {}): Cluster[] {
  let groups = topLevelGroups(paths);

  for (let guard = 0; guard < 100; guard++) {
    const largest = groups
      .filter(canSplit)
      .sort((a, b) => b.files.length - a.files.length || a.prefix.localeCompare(b.prefix))[0];
    if (!largest) break;

    const needMore = groups.length < min;
    const dominant = largest.files.length > paths.length * DOMINANT_SHARE;
    if (!needMore && !dominant) break;

    const candidate = groups.flatMap((group) => (group === largest ? split(largest) : [group]));
    // Overflowing `max` is fine while only small folders end up in "(other)",
    // but not when "(other)" would swallow the pieces we just split off.
    if (otherIsLargest(toClusters(candidate, max))) break;
    groups = candidate;
  }

  return toClusters(groups, max);
}

function otherIsLargest(clusters: Cluster[]): boolean {
  const other = clusters.find((cluster) => cluster.prefix === null);
  return other !== undefined && clusters.every((cluster) => cluster === other || cluster.files.length < other.files.length);
}

function topLevelGroups(paths: string[]): Group[] {
  const byPrefix = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.indexOf('/');
    const prefix = slash === -1 ? '' : path.slice(0, slash);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), path]);
  }
  return [...byPrefix].map(([prefix, files]) => ({ prefix, files, splittable: prefix !== '' }));
}

function canSplit(group: Group): boolean {
  return group.splittable && group.files.some((file) => file.slice(group.prefix.length + 1).includes('/'));
}

/** Splits a folder into its subfolders plus a group for the files directly inside it. */
function split(group: Group): Group[] {
  const direct: string[] = [];
  const children = new Map<string, string[]>();
  for (const file of group.files) {
    const rest = file.slice(group.prefix.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      direct.push(file);
    } else {
      const prefix = `${group.prefix}/${rest.slice(0, slash)}`;
      children.set(prefix, [...(children.get(prefix) ?? []), file]);
    }
  }

  const pieces: Group[] = [...children].map(([prefix, files]) => ({ prefix, files, splittable: true }));
  if (direct.length > 0) pieces.push({ prefix: group.prefix, files: direct, splittable: false });

  // A pass-through folder (src/main/java/...) has a single child; descend straight into it.
  const only = pieces.length === 1 ? pieces[0] : undefined;
  return only && canSplit(only) ? split(only) : pieces;
}

function toClusters(groups: Group[], max: number): Cluster[] {
  const bySize = [...groups].sort((a, b) => b.files.length - a.files.length || a.prefix.localeCompare(b.prefix));
  const kept = bySize.length > max ? bySize.slice(0, max - 1) : bySize;
  const folded = bySize.slice(kept.length);

  const clusters: Cluster[] = kept
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((group) => ({
      id: clusterNodeId(group.prefix),
      name: group.prefix === '' ? '(root)' : group.prefix,
      prefix: group.prefix,
      files: [...group.files].sort(),
    }));
  if (folded.length > 0) {
    clusters.push({ id: OTHER_CLUSTER_ID, name: '(other)', prefix: null, files: folded.flatMap((group) => group.files).sort() });
  }
  return clusters;
}
