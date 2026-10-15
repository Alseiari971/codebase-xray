// Where to start reading a repository, worked out from the graph alone: its
// entry points, the main execution path from the primary entry, one guided
// tour per important folder, and each cluster's most-used functions.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { XrayDb } from '../db/database.ts';
import type { Overview, Tour } from '../shared/api-types.ts';
import { fileNodeId } from './ids.ts';

export const TEST_PATH = /(^|\/)(test|tests|__tests__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_LANGUAGES = new Set(['typescript', 'javascript']);
/** Types describe code; tours and previews should land on code that runs. */
const RUNNABLE = "n.type NOT IN ('interface', 'type')";

const MAX_TOURS = 8;
const BRANCHES = 4;
/** Folders that hold a whole app rather than one area; tours there are named after the file. */
const SOURCE_ROOTS = new Set(['', 'src', 'lib', 'app', 'source', 'packages']);
const MAX_CHAIN = 4;

export interface EntryPoint {
  id: string;
  path: string;
  exports: string[];
  /** Edges from this file to other files. */
  uses: number;
}

/** Source files no other file imports or calls into, excluding tests. */
export function entryPoints(db: XrayDb): EntryPoint[] {
  const files = db
    .prepare(
      `SELECT f.id, f.path, f.language,
              (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
                 WHERE s.path = f.path AND t.path IS NOT f.path) AS uses
       FROM nodes f
       WHERE f.layer = 'file' AND NOT EXISTS (
         SELECT 1 FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE t.path = f.path AND s.path IS NOT f.path
       )
       ORDER BY f.path`,
    )
    .all() as { id: string; path: string; language: string; uses: number }[];
  const exportsOf = db
    .prepare(
      "SELECT coalesce(symbol, name) FROM nodes WHERE layer = 'symbol' AND path = ? AND parent_id = ? AND json_extract(metadata, '$.exported') = 1 ORDER BY start_line",
    )
    .pluck();
  return files
    .filter((file) => CODE_LANGUAGES.has(file.language) && !TEST_PATH.test(file.path) && !file.path.endsWith('.d.ts'))
    .map((file) => ({ id: file.id, path: file.path, exports: exportsOf.all(file.path, file.id) as string[], uses: file.uses }));
}

/** File-level dependencies: which files each file calls or imports, with the edges that say so. */
function fileGraph(db: XrayDb): Map<string, Map<string, number[]>> {
  const rows = db
    .prepare(
      `SELECT e.id, s.path AS source, t.path AS target FROM edges e
       JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE s.path IS NOT NULL AND t.path IS NOT NULL AND s.path != t.path AND t.layer IN ('file', 'symbol')
       ORDER BY e.id`,
    )
    .all() as { id: number; source: string; target: string }[];
  const deps = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const out = deps.get(row.source) ?? new Map<string, number[]>();
    out.set(row.target, [...(out.get(row.target) ?? []), row.id]);
    deps.set(row.source, out);
  }
  return deps;
}

/**
 * The file that execution most likely starts in: the `bin` or `main` of
 * package.json if it is an entry point, otherwise the entry point that reaches
 * the most other files.
 */
export function mainEntry(db: XrayDb, root: string, entries: EntryPoint[], reach: (path: string) => number): string | null {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string>; main?: string; module?: string };
      const declared = [...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})), pkg.main, pkg.module];
      for (const candidate of declared) {
        const path = candidate?.replace(/^\.\//, '').replace(/\\/g, '/');
        if (path && byPath.has(path)) return byPath.get(path)!.id;
      }
    } catch {
      // An unreadable package.json just means no hint.
    }
  }
  const best = [...entries].sort((a, b) => reach(b.path) - reach(a.path) || b.uses - a.uses || a.path.localeCompare(b.path))[0];
  return best && reach(best.path) > 0 ? best.id : null;
}

/**
 * From the main entry, follow single dependencies (bin -> cli) until a file
 * depends on several; then branch to the few it relies on most. A dependency
 * scores by how often it is used times how much code it leads to, so a
 * subsystem (indexer, server) beats a leaf utility called everywhere.
 */
export function mainPath(db: XrayDb, root: string): Overview['mainPath'] {
  const deps = fileGraph(db);
  const reachCache = new Map<string, number>();
  const reach = (start: string): number => {
    if (!reachCache.has(start)) {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length > 0) {
        for (const next of deps.get(queue.shift()!)?.keys() ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      reachCache.set(start, seen.size - 1);
    }
    return reachCache.get(start)!;
  };

  const entry = mainEntry(db, root, entryPoints(db), reach);
  if (!entry) return { entry: null, nodes: [], edges: [] };

  const pathOf = (id: string) => id.slice('file:'.length);
  const nodes = [entry];
  const edges: number[] = [];
  let current = pathOf(entry);
  for (let hop = 0; hop < MAX_CHAIN; hop++) {
    const score = ([path, edgeIds]: [string, number[]]) => edgeIds.length * Math.log(1 + reach(path));
    const next = [...(deps.get(current) ?? new Map<string, number[]>())]
      .filter(([path]) => !nodes.includes(fileNodeId(path)) && !TEST_PATH.test(path))
      .sort((a, b) => score(b) - score(a) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (next.length === 0) break;
    const step = next.length === 1 ? next : next.slice(0, BRANCHES);
    for (const [path, edgeIds] of step) {
      nodes.push(fileNodeId(path));
      edges.push(...edgeIds);
    }
    if (step.length > 1) break;
    current = step[0]![0];
  }
  return { entry, nodes, edges };
}

/** The most connected runnable symbols under a path prefix. */
function hubs(db: XrayDb, where: string, params: unknown[], limit: number): { id: string; name: string; path: string; links: number }[] {
  return db
    .prepare(
      `SELECT n.id, coalesce(n.symbol, n.name) AS name, n.path,
              (SELECT count(*) FROM edges e WHERE e.source = n.id OR e.target = n.id) AS links
       FROM nodes n
       WHERE n.layer = 'symbol' AND ${RUNNABLE} AND ${where}
       ORDER BY links DESC, n.id LIMIT ?`,
    )
    .all(...params, limit) as { id: string; name: string; path: string; links: number }[];
}

/**
 * One tour per important source folder, each starting at its most-used
 * function: first the folders on the main execution path, in path order, then
 * the folders whose code is most connected.
 */
export function tours(db: XrayDb, mainPathFiles: string[] = []): Tour[] {
  const folders = db
    .prepare(
      `SELECT n.path, count(e.id) AS links FROM nodes n JOIN edges e ON e.source = n.id OR e.target = n.id
       WHERE n.layer = 'symbol' AND ${RUNNABLE} GROUP BY n.path`,
    )
    .all() as { path: string; links: number }[];
  const byFolder = new Map<string, number>();
  for (const file of folders) {
    if (TEST_PATH.test(file.path)) continue;
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + file.links);
  }
  const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  const onPath = [...new Set(mainPathFiles.map((id) => folderOf(id.slice('file:'.length))))].filter((folder) => byFolder.has(folder));
  const rest = [...byFolder.keys()].filter((folder) => !onPath.includes(folder)).sort((a, b) => byFolder.get(b)! - byFolder.get(a)! || a.localeCompare(b));
  return [...onPath, ...rest]
    .map((folder) => [folder] as const)
    .slice(0, MAX_TOURS)
    .flatMap(([folder]) => {
      const [hub] = hubs(db, folder ? "n.path LIKE ? || '/%' AND n.path NOT LIKE ? || '/%/%'" : "n.path NOT LIKE '%/%'", folder ? [folder, folder] : [], 1);
      if (!hub) return [];
      const label = SOURCE_ROOTS.has(folder)
        ? hub.path.slice(hub.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
        : folder.slice(folder.lastIndexOf('/') + 1);
      return [{ id: `tour:${folder || '.'}`, title: `Tour: ${label}`, folder, target: hub.id, start: hub.name, path: hub.path }];
    });
}

/** Each cluster's two most-used runnable symbols, shown inside its box on the map. */
export function clusterPreviews(db: XrayDb, perCluster = 2): Record<string, string[]> {
  const clusters = db.prepare("SELECT id FROM nodes WHERE layer = 'cluster'").pluck().all() as string[];
  const previews: Record<string, string[]> = {};
  for (const cluster of clusters) {
    previews[cluster] = hubs(db, "n.path IN (SELECT path FROM nodes WHERE layer = 'file' AND parent_id = ?)", [cluster], perCluster).map((hub) => hub.id);
  }
  return previews;
}

export function overview(db: XrayDb, root: string): Overview {
  const path = mainPath(db, root);
  return {
    entryPoints: entryPoints(db).map((entry) => entry.id),
    mainPath: path,
    tours: tours(db, path.nodes),
    clusterPreviews: clusterPreviews(db),
  };
}
