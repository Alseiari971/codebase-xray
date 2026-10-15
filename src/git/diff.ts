import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { XrayDb } from '../db/database.ts';
import { fileNodeId } from '../graph/ids.ts';
import { detectLanguage } from '../indexer/scan.ts';
import { blastRadius } from '../graph/impact.ts';
import type { ChangedFile, ChangeStatus, DiffHunk, DiffResponse, ImpactResponse } from '../shared/api-types.ts';

/** Git's well-known empty tree, used as the base before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Everything under the indexed folder except our own index, which may not be gitignored. */
const PATHSPEC = ['.', ':(exclude).xray'];

export class DiffBaseError extends Error {}

interface RawChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  hunks: DiffHunk[];
}

export interface DiffOptions {
  /** How many hops of callers and importers count as impacted. Default 3. */
  impactDepth?: number;
}

export const DEFAULT_DIFF_IMPACT_DEPTH = 3;

/**
 * Uncommitted changes (staged, unstaged and untracked) against `base`, mapped
 * onto the indexed files and the symbols whose lines they touch, plus the
 * blast radius of those changes. The changed nodes are recorded in the
 * `git_changes` table, flagged `git-changed`. Paths are relative to `root`,
 * which may be a subfolder of the repository.
 */
export function getDiff(db: XrayDb, root: string, base = 'HEAD', options: DiffOptions = {}): DiffResponse {
  if (!isGitRepository(root)) return { isRepo: false, base, files: [], nodeIds: [], impact: emptyImpact() };

  const resolvedBase = resolveBase(root, base);
  const changes = [...trackedChanges(root, resolvedBase), ...untrackedFiles(root)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const symbolHits = changedSymbols(db, changes);
  const files = changes.map((change) => describeFile(db, root, change, symbolHits.get(change.path) ?? []));
  recordChanges(db, base, files, symbolHits);

  const nodeIds = [...new Set(files.flatMap((file) => (file.nodeId ? [file.nodeId, ...file.symbolIds] : file.symbolIds)))];
  return { isRepo: true, base, files, nodeIds, impact: changeImpact(db, files, symbolHits, options) };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isGitRepository(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

function resolveBase(root: string, base: string): string {
  // Refuse anything git could read as an option.
  if (base.startsWith('-') || /\s/.test(base)) throw new DiffBaseError(`Invalid base ref: ${base}`);
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim();
  } catch {
    if (base === 'HEAD') return EMPTY_TREE; // no commits yet
    throw new DiffBaseError(`Unknown base ref: ${base}`);
  }
}

function trackedChanges(root: string, base: string): RawChange[] {
  const output = git(root, ['diff', base, '--relative', '--no-color', '--no-ext-diff', '--find-renames', '--unified=0', '--', ...PATHSPEC]);
  return parseUnifiedDiff(output);
}

function untrackedFiles(root: string): RawChange[] {
  return git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...PATHSPEC])
    .split('\0')
    .filter(Boolean)
    .map((path) => {
      const lineCount = countLines(join(root, path));
      return {
        path,
        status: 'untracked' as const,
        hunks: lineCount > 0 ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lineCount }] : [],
      };
    });
}

/** Parses `git diff --unified=0` output into files and hunks. */
export function parseUnifiedDiff(output: string): RawChange[] {
  const changes: RawChange[] = [];
  let current: RawChange | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: '', status: 'modified', hunks: [] };
      changes.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) current.path = line.slice('rename to '.length);
    else if (line.startsWith('--- ') && current.status === 'deleted') current.path = stripPrefix(line.slice(4));
    else if (line.startsWith('+++ ') && current.status !== 'deleted') current.path = stripPrefix(line.slice(4));
    else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        current.hunks.push({
          oldStart: Number(match[1]),
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newLines: match[4] === undefined ? 1 : Number(match[4]),
        });
      }
    }
  }
  // Mode-only changes and binary files have no ---/+++ lines; take the path from the header.
  return changes.filter((change) => change.path !== '');
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '').replace(/\t$/, '');
}

interface SymbolHit {
  id: string;
  /** The changed lines inside this symbol, as [start, end] pairs. */
  ranges: [number, number][];
}

/** Line ranges a change touches in the working tree; a deleted file touches all of it. */
function changedRanges(change: Pick<RawChange, 'path' | 'status' | 'hunks'>): { path: string; start: number; end: number }[] {
  if (change.status === 'deleted') return [{ path: change.path, start: 1, end: Number.MAX_SAFE_INTEGER }];
  // A pure deletion (newLines 0) sits just after line newStart.
  return change.hunks.map((hunk) => ({
    path: change.path,
    start: hunk.newStart,
    end: hunk.newStart + Math.max(hunk.newLines, 1) - 1,
  }));
}

/** Overlaps the changed line ranges with the symbol ranges in the nodes table, in one query. */
function changedSymbols(db: XrayDb, changes: RawChange[]): Map<string, SymbolHit[]> {
  const rows = db
    .prepare(
      `WITH ranges(path, start_line, end_line) AS (
         SELECT json_extract(value, '$.path'), json_extract(value, '$.start'), json_extract(value, '$.end')
         FROM json_each(?)
       )
       SELECT n.id, n.path,
              json_group_array(json_array(max(r.start_line, n.start_line), min(r.end_line, n.end_line))) AS ranges
       FROM nodes n JOIN ranges r ON r.path = n.path
       WHERE n.layer = 'symbol' AND n.start_line <= r.end_line AND n.end_line >= r.start_line
       GROUP BY n.id
       ORDER BY n.path, n.start_line, n.id`,
    )
    .all(JSON.stringify(changes.flatMap(changedRanges))) as { id: string; path: string; ranges: string }[];

  const byPath = new Map<string, SymbolHit[]>();
  for (const row of rows) {
    const hits = byPath.get(row.path) ?? [];
    hits.push({ id: row.id, ranges: JSON.parse(row.ranges) as [number, number][] });
    byPath.set(row.path, hits);
  }
  return byPath;
}

function describeFile(db: XrayDb, root: string, change: RawChange, hits: SymbolHit[]): ChangedFile {
  const fileRow = db
    .prepare("SELECT id, content_hash FROM nodes WHERE layer = 'file' AND path = ?")
    .get(change.path) as { id: string; content_hash: string | null } | undefined;

  const absolute = join(root, change.path);
  const currentHash = existsSync(absolute) ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null;

  return {
    path: change.path,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    status: change.status,
    hunks: change.hunks,
    nodeId: fileRow ? fileNodeId(change.path) : null,
    symbolIds: hits.map((hit) => hit.id),
    // Mapping is exact for a deleted file (all its symbols), so only edits since
    // indexing, or source files the index has not seen, make it stale.
    indexStale: fileRow
      ? currentHash !== null && fileRow.content_hash !== currentHash
      : currentHash !== null && detectLanguage(change.path) !== undefined,
  };
}

/** Replaces the `git-changed` snapshot with this diff's changed files and symbols. */
function recordChanges(db: XrayDb, base: string, files: ChangedFile[], hits: Map<string, SymbolHit[]>): void {
  const detectedAt = new Date().toISOString();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO git_changes (node_id, status, base, ranges, detected_at) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    db.prepare('DELETE FROM git_changes').run();
    for (const file of files) {
      if (!file.nodeId) continue;
      const ranges = changedRanges(file).filter(() => file.status !== 'deleted').map((range) => [range.start, range.end]);
      insert.run(file.nodeId, file.status, base, JSON.stringify(ranges), detectedAt);
      for (const hit of hits.get(file.path) ?? []) insert.run(hit.id, file.status, base, JSON.stringify(hit.ranges), detectedAt);
    }
  })();
}

/**
 * Callers and importers of the changed code. Seeds are exact: the changed
 * symbols, plus a file itself when it was deleted or changed outside any
 * symbol (imports, top-level code), since then its importers are affected.
 */
function changeImpact(db: XrayDb, files: ChangedFile[], hits: Map<string, SymbolHit[]>, options: DiffOptions): ImpactResponse {
  const seeds = new Set<string>();
  for (const file of files) {
    const fileHits = hits.get(file.path) ?? [];
    for (const hit of fileHits) {
      // Editing a method's body changes the method, not every user of its class.
      const members = fileHits.filter((other) => other.id.startsWith(`${hit.id}.`));
      const inMember = (line: number) => members.some((member) => member.ranges.some(([start, end]) => line >= start && line <= end));
      const coveredByMembers = members.length > 0 && hit.ranges.every(([start, end]) => everyLine(start, end, inMember));
      if (!coveredByMembers) seeds.add(hit.id);
    }
    if (!file.nodeId) continue;
    const inSymbol = (line: number) =>
      (hits.get(file.path) ?? []).some((hit) => hit.ranges.some(([start, end]) => line >= start && line <= end));
    const outsideSymbols = changedRanges(file).some((range) => !inSymbol(range.start) || !inSymbol(range.end));
    if (file.status === 'deleted' || outsideSymbols) seeds.add(file.nodeId);
  }
  if (seeds.size === 0) return emptyImpact();
  return blastRadius(db, [...seeds], {
    direction: 'upstream',
    maxDepth: options.impactDepth ?? DEFAULT_DIFF_IMPACT_DEPTH,
    expandSeeds: false,
  });
}

function everyLine(start: number, end: number, test: (line: number) => boolean): boolean {
  for (let line = start; line <= end; line++) if (!test(line)) return false;
  return true;
}

function emptyImpact(): ImpactResponse {
  return { seeds: [], nodes: [], edges: [], files: [], summary: { symbols: 0, files: 0, clusters: 0, externals: 0 } };
}

function countLines(path: string): number {
  try {
    const text = readFileSync(path, 'utf8');
    if (text === '') return 0;
    return text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}
