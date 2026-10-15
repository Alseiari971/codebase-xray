import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, type XrayDb } from '../src/db/database.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { copyFixture, makeRepo, writeFiles } from './helpers.ts';

function rows<T>(db: XrayDb, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function filePaths(db: XrayDb): string[] {
  return rows<{ path: string }>(db, "SELECT path FROM nodes WHERE layer = 'file' ORDER BY path").map((row) => row.path);
}

/** One line per edge, so a whole graph can be compared at once. */
function edgeList(db: XrayDb): string[] {
  return rows<{ source: string; relation: string; target: string; resolution_type: string; confidence: number }>(
    db,
    'SELECT source, relation, target, resolution_type, confidence FROM edges ORDER BY source, relation, target',
  ).map((edge) => `${edge.source} -${edge.relation}-> ${edge.target} [${edge.resolution_type} ${edge.confidence}]`);
}

test('indexes source files and honours .gitignore at every level', () => {
  const root = makeRepo({
    '.gitignore': 'dist/\n*.generated.ts\n',
    'src/app.ts': 'export const app = 1;\n',
    'src/routes/login.ts': 'export function login() {}\n',
    'src/schema.generated.ts': 'export {};\n',
    'src/legacy/.gitignore': 'old/\n',
    'src/legacy/keep.ts': 'export {};\n',
    'src/legacy/old/drop.ts': 'export {};\n',
    'dist/app.js': 'compiled',
    'node_modules/dep/index.js': 'module.exports = 1;',
    '.next/server/page.js': 'built',
    'public/vendor.min.js': 'minified',
    'logo.png': 'not really a png',
  });
  const db = openDatabase(':memory:');

  const stats = indexRepository(db, root);

  assert.deepEqual(filePaths(db), ['src/app.ts', 'src/legacy/keep.ts', 'src/routes/login.ts']);
  assert.equal(stats.added, 3);
  assert.equal(stats.skipped, 3); // two .gitignore files and logo.png have no language

  const login = db.prepare("SELECT * FROM nodes WHERE id = 'file:src/routes/login.ts'").get() as Record<string, unknown>;
  assert.equal(login.name, 'login.ts');
  assert.equal(login.language, 'typescript');
  assert.match(String(login.content_hash), /^[0-9a-f]{64}$/);
});

test('extracts symbols with their hierarchy and source ranges', () => {
  const db = openDatabase(':memory:');
  indexRepository(db, copyFixture());

  const symbols = rows<{ id: string; parent_id: string; type: string; start_line: number; end_line: number }>(
    db,
    "SELECT id, parent_id, type, start_line, end_line FROM nodes WHERE layer = 'symbol' ORDER BY id",
  ).map((s) => `${s.id} (${s.type} ${s.start_line}-${s.end_line}) in ${s.parent_id}`);

  assert.deepEqual(symbols, [
    'sym:src/api/routes.ts#handleLogin (function 3-6) in file:src/api/routes.ts',
    'sym:src/auth/hash.ts#hashPassword (function 3-5) in file:src/auth/hash.ts',
    'sym:src/auth/login.ts#login (function 9-14) in file:src/auth/login.ts',
    'sym:src/db/user-repository.ts#User (interface 1-4) in file:src/db/user-repository.ts',
    'sym:src/db/user-repository.ts#UserRepository (class 6-16) in file:src/db/user-repository.ts',
    'sym:src/db/user-repository.ts#UserRepository.create (method 15-15) in sym:src/db/user-repository.ts#UserRepository',
    'sym:src/db/user-repository.ts#UserRepository.findByEmail (method 7-9) in sym:src/db/user-repository.ts#UserRepository',
    'sym:src/db/user-repository.ts#UserRepository.query (method 11-13) in sym:src/db/user-repository.ts#UserRepository',
    'sym:src/notifications/notify.ts#Notifier (interface 1-3) in file:src/notifications/notify.ts',
    'sym:src/notifications/notify.ts#notifyAll (function 5-7) in file:src/notifications/notify.ts',
    'sym:src/ui/LoginForm.tsx#Button (function 1-3) in file:src/ui/LoginForm.tsx',
    'sym:src/ui/LoginForm.tsx#LoginForm (function 5-11) in file:src/ui/LoginForm.tsx',
  ]);
});

test('builds import and call edges with resolution types', () => {
  const db = openDatabase(':memory:');
  indexRepository(db, copyFixture());

  assert.deepEqual(edgeList(db), [
    // Static method call from a script at module top level.
    'file:scripts/seed.ts -calls-> sym:src/db/user-repository.ts#UserRepository.create [deterministic 1]',
    'file:scripts/seed.ts -imports-> file:src/db/user-repository.ts [deterministic 1]',
    // Path alias `@/auth/login`.
    'file:src/api/routes.ts -imports-> file:src/auth/login.ts [deterministic 1]',
    // CommonJS: require() of a package and of a TypeScript file.
    'file:src/api/server.js -calls-> ext:npm:express [deterministic 1]',
    'file:src/api/server.js -calls-> sym:src/api/routes.ts#handleLogin [deterministic 1]',
    'file:src/api/server.js -imports-> ext:npm:express [deterministic 1]',
    'file:src/api/server.js -imports-> file:src/api/routes.ts [deterministic 1]',
    'file:src/auth/hash.ts -imports-> ext:npm:bcrypt [deterministic 1]',
    'file:src/auth/login.ts -calls-> ext:node:fs [deterministic 1]',
    'file:src/auth/login.ts -imports-> ext:node:fs [deterministic 1]',
    'file:src/auth/login.ts -imports-> file:src/auth/hash.ts [deterministic 1]',
    'file:src/auth/login.ts -imports-> file:src/db/user-repository.ts [deterministic 1]',
    'file:src/index.ts -imports-> file:src/api/routes.ts [deterministic 1]',
    'sym:src/api/routes.ts#handleLogin -calls-> sym:src/auth/login.ts#login [deterministic 1]',
    'sym:src/auth/hash.ts#hashPassword -calls-> ext:npm:bcrypt [deterministic 1]',
    'sym:src/auth/login.ts#login -calls-> sym:src/auth/hash.ts#hashPassword [deterministic 1]',
    'sym:src/auth/login.ts#login -calls-> sym:src/db/user-repository.ts#UserRepository [deterministic 1]',
    'sym:src/auth/login.ts#login -calls-> sym:src/db/user-repository.ts#UserRepository.findByEmail [deterministic 1]',
    'sym:src/db/user-repository.ts#UserRepository.create -calls-> sym:src/db/user-repository.ts#UserRepository [deterministic 1]',
    'sym:src/db/user-repository.ts#UserRepository.findByEmail -calls-> sym:src/db/user-repository.ts#UserRepository.query [deterministic 1]',
    // Through an interface we only know the contract, so it is a heuristic edge.
    'sym:src/notifications/notify.ts#notifyAll -calls-> sym:src/notifications/notify.ts#Notifier [heuristic 0.7]',
    // JSX rendering.
    'sym:src/ui/LoginForm.tsx#LoginForm -calls-> sym:src/ui/LoginForm.tsx#Button [deterministic 1]',
  ]);

  const externals = rows<{ id: string; type: string; name: string }>(
    db,
    "SELECT id, type, name FROM nodes WHERE layer = 'external' ORDER BY id",
  );
  assert.deepEqual(externals, [
    { id: 'ext:node:fs', type: 'builtin', name: 'node:fs' },
    { id: 'ext:npm:bcrypt', type: 'package', name: 'bcrypt' },
    { id: 'ext:npm:express', type: 'package', name: 'express' },
  ]);
});

test('records edge metadata and evidence for every edge', () => {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  const metadata = (source: string, relation: string, target: string) =>
    JSON.parse(
      (db.prepare('SELECT metadata FROM edges WHERE source = ? AND relation = ? AND target = ?').get(source, relation, target) as {
        metadata: string;
      }).metadata,
    );
  // One type-only and one value import of the same file: not type-only overall.
  assert.equal(metadata('file:src/auth/login.ts', 'imports', 'file:src/db/user-repository.ts').typeOnly, false);
  assert.equal(metadata('file:src/index.ts', 'imports', 'file:src/api/routes.ts').reexport, true);
  assert.deepEqual(metadata('sym:src/auth/hash.ts#hashPassword', 'calls', 'ext:npm:bcrypt').members, ['hashSync']);
  assert.deepEqual(metadata('sym:src/notifications/notify.ts#notifyAll', 'calls', 'sym:src/notifications/notify.ts#Notifier').members, ['send']);

  const withoutEvidence = rows(db, 'SELECT id FROM edges WHERE id NOT IN (SELECT edge_id FROM edge_evidence)');
  assert.deepEqual(withoutEvidence, []);

  const evidence = rows<{ file_path: string; start_line: number; end_line: number; rule: string; excerpt_hash: string }>(
    db,
    `SELECT v.file_path, v.start_line, v.end_line, v.rule, v.excerpt_hash
     FROM edges e JOIN edge_evidence ee ON ee.edge_id = e.id JOIN evidence v ON v.id = ee.evidence_id
     WHERE e.source = 'sym:src/auth/login.ts#login' AND e.target = 'sym:src/auth/hash.ts#hashPassword'`,
  );
  assert.equal(evidence.length, 1);
  const [item] = evidence;
  assert.deepEqual(
    { file: item!.file_path, start: item!.start_line, end: item!.end_line, rule: item!.rule },
    { file: 'src/auth/login.ts', start: 12, end: 12, rule: 'ts-morph:call-expression' },
  );
  const line = readFileSync(join(root, 'src/auth/login.ts'), 'utf8').split(/\r?\n/)[11]!;
  assert.match(line, /hashPassword\(/);
  assert.equal(item!.excerpt_hash, createHash('sha256').update(line).digest('hex'));

  // Both imports of user-repository.ts are cited.
  const importEvidence = rows<{ start_line: number }>(
    db,
    `SELECT v.start_line FROM edges e JOIN edge_evidence ee ON ee.edge_id = e.id JOIN evidence v ON v.id = ee.evidence_id
     WHERE e.source = 'file:src/auth/login.ts' AND e.target = 'file:src/db/user-repository.ts' ORDER BY v.start_line`,
  ).map((row) => row.start_line);
  assert.deepEqual(importEvidence, [2, 3]);
});

test('records imports that do not resolve', () => {
  const db = openDatabase(':memory:');
  const stats = indexRepository(db, copyFixture());
  const login = db.prepare("SELECT metadata FROM nodes WHERE id = 'file:src/auth/login.ts'").get() as { metadata: string };
  assert.deepEqual(JSON.parse(login.metadata).unresolvedImports, ['./does-not-exist']);
  assert.equal(stats.unresolvedImports, 1);
});

test('groups files into folder clusters', () => {
  const db = openDatabase(':memory:');
  indexRepository(db, copyFixture());

  const clusters = rows<{ id: string; name: string; files: number }>(
    db,
    `SELECT c.id, c.name, (SELECT count(*) FROM nodes f WHERE f.parent_id = c.id) AS files
     FROM nodes c WHERE c.layer = 'cluster' ORDER BY c.id`,
  );
  // src holds most files, so it is split into its feature folders.
  assert.deepEqual(clusters, [
    { id: 'cluster:', name: '(root)', files: 2 },
    { id: 'cluster:scripts', name: 'scripts', files: 1 },
    { id: 'cluster:src', name: 'src', files: 1 },
    { id: 'cluster:src/api', name: 'src/api', files: 2 },
    { id: 'cluster:src/auth', name: 'src/auth', files: 2 },
    { id: 'cluster:src/db', name: 'src/db', files: 1 },
    { id: 'cluster:src/notifications', name: 'src/notifications', files: 1 },
    { id: 'cluster:src/ui', name: 'src/ui', files: 1 },
  ]);
  assert.deepEqual(rows(db, "SELECT id FROM nodes WHERE layer = 'file' AND parent_id IS NULL"), []);
});

test('skips extraction entirely when nothing changed', () => {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  const first = indexRepository(db, root);
  const before = edgeList(db);

  const second = indexRepository(db, root);

  assert.equal(first.parsed, 9);
  assert.equal(second.parsed, 0);
  assert.equal(second.unchanged, second.files);
  assert.deepEqual(edgeList(db), before);
});

test('re-extracts changed files and the files that depend on them', () => {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  // Rename the function login.ts calls. login.ts itself is untouched.
  writeFileSync(
    join(root, 'src/auth/hash.ts'),
    "import bcrypt from 'bcrypt';\n\nexport function hashSecret(secret: string): string {\n  return bcrypt.hashSync(secret, 12);\n}\n",
  );
  const stats = indexRepository(db, root);

  assert.equal(stats.updated, 1);
  assert.equal(stats.parsed, 2); // hash.ts and its dependent login.ts
  const edges = edgeList(db);
  assert.ok(edges.includes('sym:src/auth/hash.ts#hashSecret -calls-> ext:npm:bcrypt [deterministic 1]'));
  assert.ok(!edges.some((edge) => edge.includes('hashPassword')));
  assert.ok(edges.includes('file:src/auth/login.ts -imports-> file:src/auth/hash.ts [deterministic 1]'));
  assert.equal(rows(db, 'SELECT id FROM evidence WHERE id NOT IN (SELECT evidence_id FROM edge_evidence)').length, 0);
});

test('a new file resolves imports that were previously missing', () => {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  writeFiles(root, { 'src/auth/does-not-exist.ts': 'export const missing = 1;\n' });
  const stats = indexRepository(db, root);

  assert.equal(stats.added, 1);
  assert.equal(stats.unresolvedImports, 0);
  assert.ok(edgeList(db).includes('file:src/auth/login.ts -imports-> file:src/auth/does-not-exist.ts [deterministic 1]'));
});

test('deleting a file removes its symbols and the edges into it', () => {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  rmSync(join(root, 'src/db/user-repository.ts'));
  const stats = indexRepository(db, root);

  assert.equal(stats.removed, 1);
  assert.ok(!edgeList(db).some((edge) => edge.includes('user-repository')));
  assert.deepEqual(rows(db, "SELECT id FROM nodes WHERE path = 'src/db/user-repository.ts'"), []);
  assert.deepEqual(rows(db, "SELECT id FROM evidence WHERE file_path = 'src/db/user-repository.ts'"), []);
  // The cluster that only held that file is gone too.
  assert.deepEqual(rows(db, "SELECT id FROM nodes WHERE id = 'cluster:src/db'"), []);

  const seed = db.prepare("SELECT metadata FROM nodes WHERE id = 'file:scripts/seed.ts'").get() as { metadata: string };
  assert.deepEqual(JSON.parse(seed.metadata).unresolvedImports, ['../src/db/user-repository']);
});

test('changing tsconfig.json or passing full re-extracts everything', () => {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  assert.equal(indexRepository(db, root, { full: true }).parsed, 9);

  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  tsconfig.compilerOptions.strict = false;
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  assert.equal(indexRepository(db, root).parsed, 9);
});

test('a repository without tsconfig.json still resolves relative imports', () => {
  const root = makeRepo({
    'lib/math.js': 'export function add(a, b) { return a + b; }\n',
    'lib/index.js': "import { add } from './math';\nexport const total = add(1, 2);\n",
  });
  const db = openDatabase(':memory:');
  indexRepository(db, root);

  assert.deepEqual(edgeList(db), [
    'file:lib/index.js -imports-> file:lib/math.js [deterministic 1]',
    // The call sits in an exported variable's initializer, so that symbol is the caller.
    'sym:lib/index.js#total -calls-> sym:lib/math.js#add [deterministic 1]',
  ]);
});

test('stylesheet imports become edges and existing assets are not reported as unresolved', () => {
  const root = makeRepo({
    'src/App.tsx': "import './App.css';\nimport logo from './logo.png';\nimport './gone.css';\nexport const App = () => logo;\n",
    'src/App.css': 'body {}\n',
    'src/logo.png': 'png',
  });
  const db = openDatabase(':memory:');
  const stats = indexRepository(db, root);

  assert.deepEqual(edgeList(db), ['file:src/App.tsx -imports-> file:src/App.css [deterministic 1]']);
  assert.equal(stats.unresolvedImports, 1);
  const app = db.prepare("SELECT metadata FROM nodes WHERE id = 'file:src/App.tsx'").get() as { metadata: string };
  assert.deepEqual(JSON.parse(app.metadata).unresolvedImports, ['./gone.css']);
});
