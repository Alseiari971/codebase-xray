import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { getMeta, openDatabase, SCHEMA_VERSION, setMeta } from '../src/db/database.ts';
import { makeRepo } from './helpers.ts';

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);
}

test('creates the evidence graph tables', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(tables(db), ['edge_evidence', 'edges', 'evidence', 'git_changes', 'meta', 'nodes']);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('is idempotent when reopened', () => {
  const file = join(makeRepo({}), '.xray', 'index.db');
  openDatabase(file).close();
  const db = openDatabase(file);
  assert.equal(tables(db).length, 6);
  db.close();
});

test('rejects an unknown layer and resolution_type', () => {
  const db = openDatabase(':memory:');
  assert.throws(
    () => db.prepare("INSERT INTO nodes (id, layer, type, name) VALUES ('x', 'galaxy', 'file', 'x')").run(),
    /CHECK constraint failed/,
  );

  db.prepare("INSERT INTO nodes (id, layer, type, name) VALUES ('a', 'file', 'file', 'a')").run();
  db.prepare("INSERT INTO nodes (id, layer, type, name) VALUES ('b', 'file', 'file', 'b')").run();
  assert.throws(
    () =>
      db.prepare("INSERT INTO edges (source, target, relation, resolution_type) VALUES ('a', 'b', 'imports', 'vibes')").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO edges (source, target, relation, resolution_type, confidence) VALUES ('a', 'b', 'imports', 'heuristic', 1.5)")
        .run(),
    /CHECK constraint failed/,
  );
});

test('deleting a file cascades to its symbols, edges and edge evidence', () => {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO nodes (id, layer, type, name, path) VALUES
      ('file:a.ts', 'file', 'file', 'a.ts', 'a.ts'),
      ('file:b.ts', 'file', 'file', 'b.ts', 'b.ts');
    INSERT INTO nodes (id, parent_id, layer, type, name, path, symbol, start_line, end_line)
      VALUES ('sym:a.ts#login', 'file:a.ts', 'symbol', 'function', 'login', 'a.ts', 'login', 3, 10);
    INSERT INTO edges (id, source, target, relation, resolution_type) VALUES (1, 'sym:a.ts#login', 'file:b.ts', 'calls', 'deterministic');
    INSERT INTO evidence (id, file_path, start_line, end_line, rule) VALUES (1, 'a.ts', 5, 5, 'ts-morph:call');
    INSERT INTO edge_evidence (edge_id, evidence_id) VALUES (1, 1);
  `);

  db.prepare("DELETE FROM nodes WHERE id = 'file:a.ts'").run();

  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count('nodes'), 1);
  assert.equal(count('edges'), 0);
  assert.equal(count('edge_evidence'), 0);
});

test('refuses to open an index from a different schema version', () => {
  const file = join(makeRepo({}), 'index.db');
  const raw = new Database(file);
  raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => openDatabase(file), /schema v2/);
});

test('stores meta values', () => {
  const db = openDatabase(':memory:');
  setMeta(db, { root: '/a' });
  setMeta(db, { root: '/b' });
  assert.equal(getMeta(db, 'root'), '/b');
  assert.equal(getMeta(db, 'missing'), undefined);
});
