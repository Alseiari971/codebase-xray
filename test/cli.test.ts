import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, type Io } from '../src/cli.ts';
import { copyFixture, git, makeRepo } from './helpers.ts';

async function runWith(untilShutdown: Io['untilShutdown'], ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line), untilShutdown });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Any `serve` started by these tests shuts down straight away. */
const run = (...argv: string[]) => runWith(async () => {}, ...argv);

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

test('index reports the extracted graph and honours --full', async () => {
  const root = makeRepo({
    'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
    'src/b.ts': 'export function b() { return 1; }\n',
  });
  const first = await run('index', root);
  assert.match(first.out, /Parsed 2 files\./);
  assert.match(first.out, /2 symbols, 1 import edges, 1 call edges/);

  assert.match((await run('index', root)).out, /Nothing to re-parse\./);
  assert.match((await run('index', root, '--full')).out, /Parsed 2 files\./);
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

test('mcp reports it is not implemented yet', async () => {
  const root = makeRepo({ 'a.ts': '' });
  await run('index', root);
  const { code, err } = await run('mcp', root);
  assert.equal(code, 1);
  assert.match(err, /not implemented yet/);
});

test('serve runs the UI and API until shutdown', async () => {
  const root = makeRepo({ 'src/a.ts': 'export function a() {}\n' });
  await run('index', root);

  let graphStatus = 0;
  let page = '';
  const { code, out } = await runWith(
    async (server) => {
      graphStatus = (await fetch(`${server.url}/api/graph`)).status;
      page = await (await fetch(server.url)).text();
    },
    'serve',
    root,
    '--port',
    '0',
  );

  assert.equal(code, 0);
  assert.match(out, /running at http:\/\/localhost:\d+/);
  assert.equal(graphStatus, 200);
  assert.match(page, /<div id="root">/);
});

test('a bare <path> indexes, then serves', async () => {
  const root = makeRepo({ 'a.ts': '' });
  const { code, out } = await run(root, '--port', '0');
  assert.equal(code, 0);
  assert.match(out, /Indexed 1 files[\s\S]*running at/);
});

test('flow traces a feature as a call tree', async () => {
  const root = copyFixture();
  await run('index', root);
  const { code, out } = await run('flow', 'how does login work?', root);
  assert.equal(code, 0);
  assert.equal(
    out,
    [
      'Keywords: login',
      'Traced 9 nodes from 2 entry points (calls, up to 5 hops):',
      '  handleLogin  src/api/routes.ts:3',
      '  └─ login  src/auth/login.ts:9',
      '     ├─ hashPassword  src/auth/hash.ts:3',
      '     │  └─ bcrypt  (npm package)',
      '     ├─ UserRepository  src/db/user-repository.ts:6',
      '     └─ UserRepository.findByEmail  src/db/user-repository.ts:7',
      '        └─ UserRepository.query  src/db/user-repository.ts:11',
      '  LoginForm  src/ui/LoginForm.tsx:5',
      '  └─ Button  src/ui/LoginForm.tsx:1',
    ].join('\n'),
  );
  assert.equal((await run('flow', 'how do payments work?', root)).code, 1);
  assert.equal((await run('flow', 'how does it work?', root)).code, 2);
  assert.equal((await run('flow')).code, 2);
});

test('impact prints the blast radius of a symbol, file or node id', async () => {
  const root = copyFixture();
  await run('index', root);

  const bySymbol = await run('impact', 'hashPassword', root);
  assert.equal(bySymbol.code, 0);
  assert.equal(
    bySymbol.out,
    [
      'Blast radius of hashPassword  src/auth/hash.ts:3 (upstream, up to 4 hops):',
      '  2 symbols in 3 files across 2 clusters depend on it.',
      '  1  src/auth/login.ts  login',
      '  2  src/api/routes.ts  handleLogin',
      '  3  src/api/server.js  (file-level)',
    ].join('\n'),
  );

  assert.match((await run('impact', 'src/db/user-repository.ts', root, '--depth', '1')).out, /3 files|2 files/);
  assert.match((await run('impact', 'sym:src/auth/login.ts#login', root, '--direction', 'downstream')).out, /it depends on/);
  assert.match((await run('impact', 'src/index.ts', root)).out, /Nothing depends on it/);

  const missing = await run('impact', 'nothingLikeThis', root);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /No file, symbol or node named/);
  assert.equal((await run('impact', 'login', root, '--direction', 'sideways')).code, 2);
  assert.equal((await run('impact', 'login', root, '--depth', '0')).code, 2);
});

test('diff reports changed symbols and what depends on them', async () => {
  const root = copyFixture();
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  await run('index', root);
  assert.equal((await run('diff', root)).out, 'No uncommitted changes against HEAD.');

  const path = join(root, 'src/auth/hash.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replace('hashSync(password, 10)', 'hashSync(password, 12)'));
  await run('index', root);
  const { code, out } = await run('diff', root);
  assert.equal(code, 0);
  assert.equal(
    out,
    [
      '1 file changed, 1 symbol touched (against HEAD):',
      '  M src/auth/hash.ts',
      '      hashPassword',
      '',
      'Impact: 2 symbols in 3 files across 2 clusters call or import the changed code (up to 3 hops):',
      '  1  src/auth/login.ts  login',
      '  2  src/api/routes.ts  handleLogin',
      '  3  src/api/server.js  (file-level)',
    ].join('\n'),
  );
});

test('diff outside a git repository is an error', async () => {
  const root = makeRepo({ 'a.ts': '' });
  await run('index', root);
  const { code, err } = await run('diff', root);
  assert.equal(code, 1);
  assert.match(err, /not inside a git repository/);
});
