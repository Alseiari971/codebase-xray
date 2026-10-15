import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { makeRepo, writeFiles } from './helpers.ts';

function filePaths(db: ReturnType<typeof openDatabase>): string[] {
  return (db.prepare("SELECT path FROM nodes WHERE layer = 'file' ORDER BY path").all() as { path: string }[]).map(
    (row) => row.path,
  );
}

test('indexes source files and honours .gitignore', () => {
  const root = makeRepo({
    '.gitignore': 'dist/\n*.generated.ts\n',
    'src/app.ts': 'export const app = 1;\n',
    'src/routes/login.ts': 'export function login() {}\n',
    'src/schema.generated.ts': 'export {};\n',
    'dist/app.js': 'compiled',
    'node_modules/dep/index.js': 'module.exports = 1;',
    'logo.png': 'not really a png',
  });
  const db = openDatabase(':memory:');

  const stats = indexRepository(db, root);

  assert.deepEqual(filePaths(db), ['src/app.ts', 'src/routes/login.ts']);
  assert.equal(stats.added, 2);
  assert.equal(stats.skipped, 2); // .gitignore and logo.png have no language

  const login = db.prepare("SELECT * FROM nodes WHERE id = 'file:src/routes/login.ts'").get() as Record<string, unknown>;
  assert.equal(login.name, 'login.ts');
  assert.equal(login.language, 'typescript');
  assert.match(String(login.content_hash), /^[0-9a-f]{64}$/);
});

test('re-indexing only touches changed and deleted files', () => {
  const root = makeRepo({
    'a.ts': 'export const a = 1;\n',
    'b.ts': 'export const b = 1;\n',
    'c.ts': 'export const c = 1;\n',
  });
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  // Give b.ts a symbol and some evidence so we can check they are invalidated.
  db.exec(`
    INSERT INTO nodes (id, parent_id, layer, type, name, path) VALUES ('sym:b.ts#b', 'file:b.ts', 'symbol', 'variable', 'b', 'b.ts');
    INSERT INTO evidence (file_path, start_line, end_line, rule) VALUES ('b.ts', 1, 1, 'test');
  `);

  writeFiles(root, { 'b.ts': 'export const b = 2;\n', 'd.ts': 'export const d = 1;\n' });
  rmSync(join(root, 'c.ts'));

  const stats = indexRepository(db, root);

  assert.deepEqual(
    { added: stats.added, updated: stats.updated, unchanged: stats.unchanged, removed: stats.removed },
    { added: 1, updated: 1, unchanged: 1, removed: 1 },
  );
  assert.deepEqual(filePaths(db), ['a.ts', 'b.ts', 'd.ts']);
  assert.equal((db.prepare("SELECT count(*) AS n FROM nodes WHERE layer = 'symbol'").get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM evidence').get() as { n: number }).n, 0);
});
