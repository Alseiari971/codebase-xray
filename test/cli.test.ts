import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { makeRepo } from './helpers.ts';

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('--help lists every command', async () => {
  const { code, out } = await run('--help');
  assert.equal(code, 0);
  for (const command of ['xray index <path>', 'xray serve <path>', 'xray diff', 'xray mcp <path>']) {
    assert.ok(out.includes(command), `help is missing "${command}"`);
  }
});

test('--version prints the package version', async () => {
  const { code, out } = await run('--version');
  assert.equal(code, 0);
  assert.match(out, /^\d+\.\d+\.\d+$/);
});

test('usage errors exit with code 2', async () => {
  assert.equal((await run('index')).code, 2);
  assert.equal((await run('index', 'a', 'b')).code, 2);
  assert.equal((await run('index', join(makeRepo({}), 'missing'))).code, 2);
  assert.equal((await run('frobnicate')).code, 2);
  assert.equal((await run('--nope')).code, 2);
  assert.equal((await run('serve', makeRepo({}), '--port', 'abc')).code, 2);
});

test('index builds the evidence graph in <path>/.xray', async () => {
  const root = makeRepo({ 'src/index.ts': 'export {};\n' });
  const { code, out } = await run('index', root);
  assert.equal(code, 0);
  assert.match(out, /Indexed 1 files/);
  assert.ok(existsSync(join(root, '.xray', 'index.db')));
});

test('--db overrides the index location', async () => {
  const root = makeRepo({ 'a.ts': '' });
  const db = join(makeRepo({}), 'custom.db');
  assert.equal((await run('index', root, '--db', db)).code, 0);
  assert.ok(existsSync(db));
  assert.ok(!existsSync(join(root, '.xray')));
});

test('serve, diff and mcp require an index first', async () => {
  const root = makeRepo({ 'a.ts': '' });
  for (const argv of [['serve', root], ['diff', root], ['mcp', root], ['--uncommitted', root]]) {
    const { code, err } = await run(...argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(err, /No index found/);
  }
});

test('serve, diff and mcp report they are not implemented yet', async () => {
  const root = makeRepo({ 'a.ts': '' });
  await run('index', root);
  for (const argv of [['serve', root], ['diff', root], ['mcp', root], ['diff', '--uncommitted', root]]) {
    const { code, err } = await run(...argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(err, /not implemented yet/);
  }
});

test('a bare <path> indexes the repository', async () => {
  const root = makeRepo({ 'a.ts': '' });
  const { out } = await run(root);
  assert.match(out, /Indexed 1 files/);
});
