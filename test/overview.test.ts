import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { clusterPreviews, entryPoints, mainPath, overview, tours } from '../src/graph/overview.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { startServer } from '../src/server/server.ts';
import type { Overview } from '../src/shared/api-types.ts';
import { copyFixture, makeRepo } from './helpers.ts';

function indexed(root: string) {
  const db = openDatabase(':memory:');
  indexRepository(db, root);
  return db;
}

test('entry points are source files nothing else uses, tests excluded', () => {
  const db = indexed(copyFixture());
  assert.deepEqual(entryPoints(db).map((entry) => entry.path), [
    'scripts/seed.ts',
    'src/api/server.js',
    'src/index.ts',
    'src/notifications/notify.ts',
    'src/ui/LoginForm.tsx',
  ]);
});

test('without a package.json hint, the main path starts at the entry that reaches the most code', () => {
  const root = copyFixture();
  const path = mainPath(indexed(root), root);
  // server.js and index.ts both reach 4 files; server.js uses more, so it wins.
  assert.equal(path.entry, 'file:src/api/server.js');
  // Single dependencies are followed, then the path branches.
  assert.deepEqual(path.nodes, [
    'file:src/api/server.js',
    'file:src/api/routes.ts',
    'file:src/auth/login.ts',
    'file:src/db/user-repository.ts',
    'file:src/auth/hash.ts',
  ]);
  assert.ok(path.edges.length >= 4);
});

test('package.json bin or main picks the entry', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'tool', bin: { tool: './bin/tool.js' } }),
    'bin/tool.js': "import { run } from '../src/run.js';\nrun();\n",
    'src/run.ts': "import { helper } from './helper';\nexport function run() { helper(); }\n",
    'src/helper.ts': 'export function helper() {}\n',
    // A bigger entry that package.json does not name.
    'scripts/build.ts': "import { run } from '../src/run';\nimport { helper } from '../src/helper';\nexport function build() { run(); helper(); }\n",
  });
  const path = mainPath(indexed(root), root);
  assert.equal(path.entry, 'file:bin/tool.js');
  assert.deepEqual(path.nodes, ['file:bin/tool.js', 'file:src/run.ts', 'file:src/helper.ts']);
});

test('a repository with no code has no main path', () => {
  const root = makeRepo({ 'README.md': '# hi\n' });
  assert.deepEqual(mainPath(indexed(root), root), { entry: null, nodes: [], edges: [] });
});

test('tours start on the main path, then follow the most connected folders', () => {
  const root = copyFixture();
  const db = indexed(root);
  const list = tours(db, mainPath(db, root).nodes);
  assert.deepEqual(list.map((tour) => `${tour.title} -> ${tour.start}`), [
    'Tour: api -> handleLogin',
    'Tour: auth -> login',
    'Tour: db -> UserRepository',
    'Tour: ui -> Button',
    'Tour: notifications -> notifyAll',
  ]);
  assert.deepEqual(list[1], {
    id: 'tour:src/auth',
    title: 'Tour: auth',
    folder: 'src/auth',
    target: 'sym:src/auth/login.ts#login',
    start: 'login',
    path: 'src/auth/login.ts',
  });
});

test('a tour for a source root is named after its main file', () => {
  const root = makeRepo({
    'src/cli.ts': "import { util } from './util';\nexport function main() { util(); util(); }\n",
    'src/util.ts': 'export function util() {}\n',
  });
  const db = indexed(root);
  assert.equal(tours(db)[0]!.title, 'Tour: cli');
});

test('cluster previews list the two most-used runnable functions', () => {
  const previews = clusterPreviews(indexed(copyFixture()));
  assert.deepEqual(previews['cluster:src/auth'], ['sym:src/auth/login.ts#login', 'sym:src/auth/hash.ts#hashPassword']);
  // Interfaces never appear: User is skipped in favour of the class and a method.
  assert.deepEqual(previews['cluster:src/db'], ['sym:src/db/user-repository.ts#UserRepository', 'sym:src/db/user-repository.ts#UserRepository.create']);
  assert.deepEqual(previews['cluster:'], []);
});

test('GET /api/overview returns all of it', async () => {
  const root = copyFixture();
  const db = indexed(root);
  const server = await startServer({ db, root, port: 0 });
  try {
    const body = (await (await fetch(`${server.url}/api/overview`)).json()) as Overview;
    assert.deepEqual(body, overview(db, root));
    assert.equal(body.mainPath.entry, 'file:src/api/server.js');
    assert.equal(body.tours.length, 5);
  } finally {
    await server.close();
    db.close();
  }
});
