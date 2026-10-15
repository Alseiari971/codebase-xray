import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, type XrayDb } from '../src/db/database.ts';
import { blastRadius } from '../src/graph/impact.ts';
import { keywords, stem, traceQuestion, words } from '../src/graph/question.ts';
import { reach, shortestPaths, subtree } from '../src/graph/traverse.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { copyFixture } from './helpers.ts';

/**
 * a -> b -> c -> d, with a cycle c -> b, a shortcut a -> c through an import,
 * and x containing x1 which calls a.
 */
function smallGraph(): XrayDb {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO nodes (id, layer, type, name) VALUES
      ('a', 'symbol', 'function', 'a'), ('b', 'symbol', 'function', 'b'),
      ('c', 'symbol', 'function', 'c'), ('d', 'symbol', 'function', 'd'),
      ('x', 'file', 'file', 'x');
    INSERT INTO nodes (id, parent_id, layer, type, name) VALUES ('x1', 'x', 'symbol', 'function', 'x1');
    INSERT INTO edges (id, source, target, relation, resolution_type) VALUES
      (1, 'a', 'b', 'calls', 'deterministic'),
      (2, 'b', 'c', 'calls', 'deterministic'),
      (3, 'c', 'd', 'calls', 'deterministic'),
      (4, 'c', 'b', 'calls', 'deterministic'),
      (5, 'a', 'c', 'imports', 'deterministic'),
      (6, 'x1', 'a', 'calls', 'deterministic');
  `);
  return db;
}

const sorted = (depths: Map<string, number>) => [...depths].sort(([a], [b]) => a.localeCompare(b));

test('downstream reach records the shortest distance and stops on cycles', () => {
  const db = smallGraph();
  const result = reach(db, ['a'], { direction: 'downstream', maxDepth: 10, relations: ['calls'] });
  assert.deepEqual(sorted(result.depths), [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  // Only edges that step one layer further; the c -> b back edge is not one.
  assert.deepEqual(result.edges.map((edge) => edge.id), [1, 2, 3]);
});

test('relations and maxDepth limit the walk', () => {
  const db = smallGraph();
  assert.deepEqual(sorted(reach(db, ['a'], { direction: 'downstream', maxDepth: 1, relations: ['calls'] }).depths), [['a', 0], ['b', 1]]);
  const both = reach(db, ['a'], { direction: 'downstream', maxDepth: 10, relations: ['calls', 'imports'] });
  assert.equal(both.depths.get('c'), 1); // the import is a shortcut
});

test('upstream reach finds callers, and containers expand to their contents', () => {
  const db = smallGraph();
  const callers = reach(db, ['b'], { direction: 'upstream', maxDepth: 10, relations: ['calls'] });
  assert.deepEqual(sorted(callers.depths), [['a', 1], ['b', 0], ['c', 1], ['x1', 2]]);

  const fromFile = reach(db, ['x'], { direction: 'downstream', maxDepth: 1, relations: ['calls'] });
  assert.deepEqual(sorted(fromFile.depths), [['a', 1], ['x', 0], ['x1', 0]]);
  const exact = reach(db, ['x'], { direction: 'downstream', maxDepth: 1, relations: ['calls'], expandSeeds: false });
  assert.deepEqual(sorted(exact.depths), [['x', 0]]);
});

test('shortest paths list every equally short route', () => {
  const db = smallGraph();
  assert.deepEqual(shortestPaths(db, 'a', 'd', { maxDepth: 10, relations: ['calls', 'imports'], limit: 5 }).paths, [
    { nodes: ['a', 'c', 'd'], edges: [5, 3] },
  ]);
  assert.deepEqual(shortestPaths(db, 'x', 'd', { maxDepth: 10, relations: ['calls'], limit: 5 }).paths, [
    { nodes: ['x1', 'a', 'b', 'c', 'd'], edges: [6, 1, 2, 3] },
  ]);
  assert.deepEqual(shortestPaths(db, 'd', 'a', { maxDepth: 10, relations: ['calls'], limit: 5 }).paths, []);
  assert.deepEqual(shortestPaths(db, 'a', 'd', { maxDepth: 2, relations: ['calls'], limit: 5 }).paths, []);
});

test('subtree lists a node and everything inside it', () => {
  assert.deepEqual(subtree(smallGraph(), 'x').sort(), ['x', 'x1']);
});

test('blast radius groups what depends on a symbol by file', () => {
  const db = openDatabase(':memory:');
  indexRepository(db, copyFixture());

  const impact = blastRadius(db, ['sym:src/auth/hash.ts#hashPassword']);
  assert.deepEqual(
    impact.nodes.map((node) => `${node.depth} ${node.id}`),
    ['1 sym:src/auth/login.ts#login', '2 sym:src/api/routes.ts#handleLogin', '3 file:src/api/server.js'],
  );
  assert.deepEqual(impact.files.map((file) => `${file.depth} ${file.path}`), [
    '1 src/auth/login.ts',
    '2 src/api/routes.ts',
    '3 src/api/server.js',
  ]);
  assert.deepEqual(impact.summary, { symbols: 2, files: 3, clusters: 2, externals: 0 });
  assert.equal(impact.edges.length, 3);
});

test('blast radius of a file covers its importers and the callers of its symbols, but not itself', () => {
  const db = openDatabase(':memory:');
  indexRepository(db, copyFixture());

  const impact = blastRadius(db, ['file:src/db/user-repository.ts'], { maxDepth: 1 });
  const ids = impact.nodes.map((node) => node.id).sort();
  assert.deepEqual(ids, ['file:scripts/seed.ts', 'file:src/auth/login.ts', 'sym:src/auth/login.ts#login']);
  assert.ok(!ids.some((id) => id.includes('user-repository')));

  const downstream = blastRadius(db, ['sym:src/auth/login.ts#login'], { direction: 'downstream', maxDepth: 1, relations: ['calls'] });
  assert.deepEqual(downstream.nodes.map((node) => node.id).sort(), [
    'sym:src/auth/hash.ts#hashPassword',
    'sym:src/db/user-repository.ts#UserRepository',
    'sym:src/db/user-repository.ts#UserRepository.findByEmail',
  ]);
});

test('question words are split, filtered and stemmed', () => {
  assert.deepEqual(words('handleLogin.ts HTTPServer user_repo'), ['handle', 'login', 'ts', 'http', 'server', 'user', 'repo']);
  assert.deepEqual(keywords('How does the checkout work?'), ['checkout']);
  assert.deepEqual(keywords('What happens when users log in'), ['user', 'log']);
  assert.deepEqual(['indexing', 'indexer', 'indexes', 'status', 'class', 'logins', 'categories'].map(stem), [
    'index', 'index', 'index', 'status', 'class', 'login', 'category',
  ]);
});

test('a question traces from its most upstream matches', () => {
  const db = openDatabase(':memory:');
  indexRepository(db, copyFixture());

  const trace = traceQuestion(db, 'How does login work?', { maxDepth: 5, relations: ['calls'] });
  assert.deepEqual(trace.keywords, ['login']);
  // login() is called by handleLogin(), so it is not an entry point itself.
  assert.deepEqual(trace.entryPoints, ['sym:src/api/routes.ts#handleLogin', 'sym:src/ui/LoginForm.tsx#LoginForm']);
  assert.ok(trace.matches.includes('sym:src/auth/login.ts#login'));
  assert.deepEqual([...trace.depths.keys()].sort(), [
    'ext:npm:bcrypt',
    'sym:src/api/routes.ts#handleLogin',
    'sym:src/auth/hash.ts#hashPassword',
    'sym:src/auth/login.ts#login',
    'sym:src/db/user-repository.ts#UserRepository',
    'sym:src/db/user-repository.ts#UserRepository.findByEmail',
    'sym:src/db/user-repository.ts#UserRepository.query',
    'sym:src/ui/LoginForm.tsx#Button',
    'sym:src/ui/LoginForm.tsx#LoginForm',
  ]);

  assert.deepEqual(traceQuestion(db, 'how does it work?', { maxDepth: 5, relations: ['calls'] }).entryPoints, []);
  assert.deepEqual(traceQuestion(db, 'how do payments work?', { maxDepth: 5, relations: ['calls'] }).matches, []);
});
