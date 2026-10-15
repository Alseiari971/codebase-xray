import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { DiffBaseError, getDiff, parseUnifiedDiff } from '../src/git/diff.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { copyFixture, git, makeRepo, writeFiles } from './helpers.ts';

test('parses files, statuses and hunks from git diff output', () => {
  const output = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3 +3 @@ export function a() {',
    '-  return 1;',
    '+  return 2;',
    '@@ -10,2 +10,0 @@',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,4 @@',
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,7 +0,0 @@',
    'diff --git a/src/x.ts b/src/y.ts',
    'similarity index 90%',
    'rename from src/x.ts',
    'rename to src/y.ts',
    '--- a/src/x.ts',
    '+++ b/src/y.ts',
    '@@ -2,0 +3,1 @@',
    '',
  ].join('\n');

  assert.deepEqual(parseUnifiedDiff(output), [
    {
      path: 'src/a.ts',
      status: 'modified',
      hunks: [
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
        { oldStart: 10, oldLines: 2, newStart: 10, newLines: 0 },
      ],
    },
    { path: 'src/new.ts', status: 'added', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 }] },
    { path: 'src/old.ts', status: 'deleted', hunks: [{ oldStart: 1, oldLines: 7, newStart: 0, newLines: 0 }] },
    { path: 'src/y.ts', oldPath: 'src/x.ts', status: 'renamed', hunks: [{ oldStart: 2, oldLines: 0, newStart: 3, newLines: 1 }] },
  ]);
});

/** The fixture as a git repository with one commit, indexed. */
function committedFixture() {
  const root = copyFixture();
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  const db = openDatabase(':memory:');
  indexRepository(db, root);
  return { root, db };
}

test('maps uncommitted changes onto files and the symbols they touch', () => {
  const { root, db } = committedFixture();
  assert.deepEqual(getDiff(db, root).files, []);

  // Edit inside UserRepository.findByEmail (lines 7-9), delete hash.ts, add a new file.
  const repoPath = join(root, 'src/db/user-repository.ts');
  writeFileSync(repoPath, readFileSync(repoPath, 'utf8').replace("WHERE email = '${email}'", 'WHERE email = ?'));
  rmSync(join(root, 'src/auth/hash.ts'));
  writeFiles(root, { 'src/auth/otp.ts': 'export function otp() {\n  return 42;\n}\n' });

  const diff = getDiff(db, root);
  const byPath = new Map(diff.files.map((file) => [file.path, file]));

  assert.deepEqual([...byPath.keys()], ['src/auth/hash.ts', 'src/auth/otp.ts', 'src/db/user-repository.ts']);

  const repo = byPath.get('src/db/user-repository.ts')!;
  assert.equal(repo.status, 'modified');
  assert.equal(repo.nodeId, 'file:src/db/user-repository.ts');
  assert.deepEqual(repo.hunks, [{ oldStart: 8, oldLines: 1, newStart: 8, newLines: 1 }]);
  assert.deepEqual(repo.symbolIds, [
    'sym:src/db/user-repository.ts#UserRepository',
    'sym:src/db/user-repository.ts#UserRepository.findByEmail',
  ]);
  assert.equal(repo.indexStale, true); // edited after indexing

  const hash = byPath.get('src/auth/hash.ts')!;
  assert.equal(hash.status, 'deleted');
  assert.deepEqual(hash.symbolIds, ['sym:src/auth/hash.ts#hashPassword']);
  assert.equal(hash.indexStale, false); // every symbol of a deleted file is exactly what changed

  const otp = byPath.get('src/auth/otp.ts')!;
  assert.equal(otp.status, 'untracked');
  assert.equal(otp.nodeId, null);
  assert.deepEqual(otp.hunks, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }]);
  assert.equal(otp.indexStale, true); // a source file the index has not seen

  assert.ok(diff.nodeIds.includes('sym:src/db/user-repository.ts#UserRepository.findByEmail'));
  assert.ok(diff.nodeIds.includes('file:src/auth/hash.ts'));

  // Flagged git-changed in the index, with the changed lines inside each node.
  const flagged = db.prepare('SELECT node_id, relation, status, ranges FROM git_changes ORDER BY node_id').all();
  assert.deepEqual(flagged, [
    { node_id: 'file:src/auth/hash.ts', relation: 'git-changed', status: 'deleted', ranges: '[]' },
    { node_id: 'file:src/db/user-repository.ts', relation: 'git-changed', status: 'modified', ranges: '[[8,8]]' },
    { node_id: 'sym:src/auth/hash.ts#hashPassword', relation: 'git-changed', status: 'deleted', ranges: '[[3,5]]' },
    { node_id: 'sym:src/db/user-repository.ts#UserRepository', relation: 'git-changed', status: 'modified', ranges: '[[8,8]]' },
    { node_id: 'sym:src/db/user-repository.ts#UserRepository.findByEmail', relation: 'git-changed', status: 'modified', ranges: '[[8,8]]' },
  ]);

  // Blast radius: callers and importers of the changed code, but not the changed code itself.
  assert.deepEqual(
    diff.impact.nodes.map((node) => `${node.depth} ${node.id}`),
    [
      '1 file:src/auth/login.ts', // imports the deleted hash.ts
      '1 sym:src/auth/login.ts#login', // calls hashPassword and findByEmail
      '2 file:src/api/routes.ts',
      '2 sym:src/api/routes.ts#handleLogin',
      '3 file:src/api/server.js',
      '3 file:src/index.ts',
    ],
  );
  // seed.ts imports user-repository.ts but only calls UserRepository.create, which did not change.
  assert.ok(!diff.impact.nodes.some((node) => node.id.includes('seed')));

  // After re-indexing, the mapping is exact again.
  indexRepository(db, root);
  const refreshed = getDiff(db, root).files.find((file) => file.path === 'src/auth/otp.ts')!;
  assert.equal(refreshed.indexStale, false);
  assert.deepEqual(refreshed.symbolIds, ['sym:src/auth/otp.ts#otp']);
});

test('a clean working tree clears the git-changed flags', () => {
  const { root, db } = committedFixture();
  writeFiles(root, { 'src/index.ts': "export * from './api/routes';\n// edited\n" });
  assert.equal(getDiff(db, root).nodeIds.length, 1);
  assert.equal(db.prepare('SELECT count(*) FROM git_changes').pluck().get(), 1);

  git(root, 'checkout', '--', 'src/index.ts');
  const clean = getDiff(db, root);
  assert.deepEqual([clean.files, clean.impact.nodes], [[], []]);
  assert.equal(db.prepare('SELECT count(*) FROM git_changes').pluck().get(), 0);
});

test('a change to a class itself, not just a method body, impacts code that uses the class', () => {
  const { root, db } = committedFixture();
  const path = join(root, 'src/db/user-repository.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replace('export class UserRepository {', 'export class UserRepository extends Object {'));
  const diff = getDiff(db, root);
  assert.deepEqual(diff.impact.seeds, ['sym:src/db/user-repository.ts#UserRepository']);
  assert.ok(diff.impact.nodes.some((node) => node.id === 'sym:src/db/user-repository.ts#UserRepository.create'));
  assert.ok(diff.impact.nodes.some((node) => node.id === 'sym:src/auth/login.ts#login'));
});

test('a change outside any symbol makes the file\'s importers impacted', () => {
  const { root, db } = committedFixture();
  // A new import at the top of hash.ts, outside hashPassword().
  writeFiles(root, { 'src/auth/hash.ts': `import { join } from 'node:path';\n${readFileSync(join(root, 'src/auth/hash.ts'), 'utf8')}` });
  const diff = getDiff(db, root);
  assert.deepEqual(diff.impact.seeds, ['file:src/auth/hash.ts']);
  assert.equal(diff.impact.nodes[0]!.id, 'file:src/auth/login.ts');
});

test('ignores the .xray index even when it is not gitignored', () => {
  const { root, db } = committedFixture();
  writeFiles(root, { '.xray/index.db': 'sqlite', '.xray/index.db-wal': 'wal' });
  assert.deepEqual(getDiff(db, root).files, []);
});

test('diffs against another base ref', () => {
  const { root, db } = committedFixture();
  writeFiles(root, { 'src/index.ts': "export * from './api/routes';\nexport const version = 2;\n" });
  git(root, 'commit', '-q', '-am', 'second');

  assert.deepEqual(getDiff(db, root).files, []);
  assert.deepEqual(getDiff(db, root, 'HEAD~1').files.map((file) => [file.path, file.status]), [['src/index.ts', 'modified']]);
});

test('rejects bad base refs', () => {
  const { root, db } = committedFixture();
  assert.throws(() => getDiff(db, root, '--output=/tmp/x'), DiffBaseError);
  assert.throws(() => getDiff(db, root, 'no-such-branch'), DiffBaseError);
});

test('a repository without commits diffs against the empty tree', () => {
  const root = makeRepo({ 'a.ts': 'export const a = 1;\n' });
  git(root, 'init', '-q');
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  const diff = getDiff(db, root);
  assert.equal(diff.isRepo, true);
  assert.deepEqual(diff.files.map((file) => [file.path, file.status]), [['a.ts', 'untracked']]);
  assert.deepEqual(diff.files[0]!.symbolIds, ['sym:a.ts#a']);
});

test('paths are relative to an indexed subfolder of the repository', () => {
  const root = makeRepo({ 'app/src/a.ts': 'export const a = 1;\n', 'other/b.ts': 'export const b = 1;\n' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  const app = join(root, 'app');
  const db = openDatabase(':memory:');
  indexRepository(db, app);

  writeFiles(root, { 'app/src/a.ts': 'export const a = 2;\n', 'other/b.ts': 'export const b = 2;\n' });
  const diff = getDiff(db, app);
  assert.deepEqual(diff.files.map((file) => [file.path, file.nodeId]), [['src/a.ts', 'file:src/a.ts']]);
});
