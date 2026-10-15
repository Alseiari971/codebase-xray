import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterFiles } from '../src/indexer/cluster.ts';

const summary = (paths: string[], options?: Parameters<typeof clusterFiles>[1]) =>
  clusterFiles(paths, options).map((cluster) => `${cluster.name}: ${cluster.files.length}`);

test('splits a dominant src folder into feature clusters', () => {
  const paths = [
    'README.md',
    'package.json',
    'src/main.ts',
    'src/auth/login.ts',
    'src/auth/session.ts',
    'src/api/routes.ts',
    'src/api/handlers/user.ts',
    'src/db/client.ts',
    'src/ui/App.tsx',
    'test/auth.test.ts',
  ];
  assert.deepEqual(summary(paths), ['(root): 2', 'src: 1', 'src/api: 2', 'src/auth: 2', 'src/db: 1', 'src/ui: 1', 'test: 1']);
});

test('keeps top-level folders when there are already enough and none dominates', () => {
  const paths = ['app/a.ts', 'app/b/c.ts', 'lib/a.ts', 'lib/b/c.ts', 'server/a.ts', 'scripts/a.ts', 'docs/a.md'];
  assert.deepEqual(summary(paths), ['app: 2', 'docs: 1', 'lib: 2', 'scripts: 1', 'server: 1']);
});

test('descends through pass-through folders', () => {
  const paths = [
    'src/main/java/com/acme/auth/Login.java',
    'src/main/java/com/acme/auth/Token.java',
    'src/main/java/com/acme/billing/Invoice.java',
    'src/main/java/com/acme/billing/Payment.java',
    'src/main/java/com/acme/App.java',
  ];
  assert.deepEqual(summary(paths), [
    'src/main/java/com/acme: 1',
    'src/main/java/com/acme/auth: 2',
    'src/main/java/com/acme/billing: 2',
  ]);
});

test('folds the smallest folders into (other) beyond the maximum', () => {
  const paths = Array.from({ length: 14 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `pkg${String(i).padStart(2, '0')}/f${j}.ts`)).flat();
  const clusters = clusterFiles(paths, { max: 10 });
  assert.equal(clusters.length, 10);
  const other = clusters.at(-1)!;
  assert.equal(other.name, '(other)');
  assert.equal(other.prefix, null);
  assert.equal(other.files.length, 1 + 2 + 3 + 4 + 5); // pkg00..pkg04
  assert.equal(clusters.reduce((sum, cluster) => sum + cluster.files.length, 0), paths.length);
});

test('does not split a dominant folder into an unreadable number of clusters', () => {
  const paths = [
    ...Array.from({ length: 20 }, (_, i) => `components/c${i}/index.tsx`),
    'lib/a.ts', 'lib/b.ts', 'pages/a.tsx', 'pages/b.tsx', 'styles/a.css',
  ];
  assert.deepEqual(summary(paths), ['components: 20', 'lib: 2', 'pages: 2', 'styles: 1']);
});

test('splits a dominant monorepo folder even when tiny folders must fold into (other)', () => {
  const paths = [
    ...Array.from({ length: 30 }, (_, i) => `packages/core/f${i}.ts`),
    ...Array.from({ length: 20 }, (_, i) => `packages/ui/f${i}.tsx`),
    ...Array.from({ length: 10 }, (_, i) => `packages/utils/f${i}.ts`),
    ...['app', 'docs', 'examples', 'scripts', '.github', 'public', 'firebase', 'dev', 'e2e'].map((dir) => `${dir}/x.ts`),
  ];
  const clusters = summary(paths);
  assert.equal(clusters.length, 10);
  assert.deepEqual(clusters.slice(-4), ['packages/core: 30', 'packages/ui: 20', 'packages/utils: 10', '(other): 3']);
});

test('a tiny repository may have fewer clusters than the minimum', () => {
  assert.deepEqual(summary(['index.ts', 'util.ts']), ['(root): 2']);
  assert.deepEqual(clusterFiles([]), []);
});

test('every file lands in exactly one cluster', () => {
  const paths = ['a.ts', 'x/y/z/1.ts', 'x/y/2.ts', 'x/3.ts', 'w/4.ts', 'v/5.ts', 'u/6.ts'];
  const assigned = clusterFiles(paths).flatMap((cluster) => cluster.files).sort();
  assert.deepEqual(assigned, [...paths].sort());
});
