import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { XrayDb } from '../db/database.ts';
import { fileNodeId } from '../graph/ids.ts';
import { detectLanguage } from '../indexer/scan.ts';
import type { ChangedFile, ChangeStatus, DiffHunk, DiffResponse } from '../shared/api-types.ts';

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

/**
 * Uncommitted changes (staged, unstaged and untracked) against `base`,
 * mapped onto the indexed files and the symbols whose lines they touch.
 * Paths are relative to `root`, which may be a subfolder of the repository.
 */
export function getDiff(db: XrayDb, root: string, base = 'HEAD'): DiffResponse {
  if (!isGitRepository(root)) return { isRepo: false, base, files: [], nodeIds: [] };

  const resolvedBase = resolveBase(root, base);
  const changes = [...trackedChanges(root, resolvedBase), ...untrackedFiles(root)];

  const files = changes
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((change) => mapToNodes(db, root, change));
  const nodeIds = files.flatMap((file) => (file.nodeId ? [file.nodeId, ...file.symbolIds] : file.symbolIds));
  return { isRepo: true, base, files, nodeIds: [...new Set(nodeIds)] };
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

function mapToNodes(db: XrayDb, root: string, change: RawChange): ChangedFile {
  const fileRow = db
    .prepare("SELECT id, content_hash FROM nodes WHERE layer = 'file' AND path = ?")
    .get(change.path) as { id: string; content_hash: string | null } | undefined;

  const symbols = db
    .prepare("SELECT id, start_line, end_line FROM nodes WHERE layer = 'symbol' AND path = ? ORDER BY start_line, id")
    .all(change.path) as { id: string; start_line: number; end_line: number }[];

  const symbolIds =
    change.status === 'deleted'
      ? symbols.map((symbol) => symbol.id)
      : symbols
          .filter((symbol) =>
            change.hunks.some((hunk) => {
              // A pure deletion (newLines 0) sits just after line newStart.
              const start = hunk.newStart;
              const end = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
              return start <= symbol.end_line && end >= symbol.start_line;
            }),
          )
          .map((symbol) => symbol.id);

  const absolute = join(root, change.path);
  const currentHash = existsSync(absolute) ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null;

  return {
    path: change.path,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    status: change.status,
    hunks: change.hunks,
    nodeId: fileRow ? fileNodeId(change.path) : null,
    symbolIds,
    // Mapping is exact for a deleted file (all its symbols), so only edits since
    // indexing, or source files the index has not seen, make it stale.
    indexStale: fileRow
      ? currentHash !== null && fileRow.content_hash !== currentHash
      : currentHash !== null && detectLanguage(change.path) !== undefined,
  };
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
