import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openDatabase, type XrayDb } from '../src/db/database.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import type { EdgeEvidenceResponse, FlowResponse, GraphResponse, NodeEvidenceResponse } from '../src/shared/api-types.ts';
import { copyFixture } from './helpers.ts';

let root: string;
let db: XrayDb;
let server: RunningServer;


async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

async function post<T>(path: string, body: unknown, contentType = 'application/json'): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

const nodeEvidence = (id: string) => get<NodeEvidenceResponse>(`/api/node/${encodeURIComponent(id)}/evidence`);

function edgeId(graph: GraphResponse, source: string, target: string): number {
  const edge = graph.edges.find((e) => e.source === source && e.target === target);
  assert.ok(edge, `no edge ${source} -> ${target}`);
  return edge.id;
}

// One server for every suite. Hooks live inside a suite: on Node 20 a
// top-level before() is not awaited before describe() blocks start.
describe('local HTTP server', () => {
before(async () => {
  root = copyFixture();
  db = openDatabase(':memory:');
  indexRepository(db, root);
  server = await startServer({ db, root, port: 0 });
});
after(async () => {
  await server.close();
  db.close();
});

describe('GET /api/graph', () => {
  test('returns every node and edge with parsed metadata', async () => {
    const { status, body } = await get<GraphResponse>('/api/graph');
    assert.equal(status, 200);
    assert.equal(body.root, root);
    assert.ok(body.indexedAt);
    const layers = new Set(body.nodes.map((node) => node.layer));
    assert.deepEqual([...layers].sort(), ['cluster', 'external', 'file', 'symbol']);
    const login = body.nodes.find((node) => node.id === 'sym:src/auth/login.ts#login')!;
    assert.deepEqual(
      { parentId: login.parentId, startLine: login.startLine, endLine: login.endLine, exported: login.metadata.exported },
      { parentId: 'file:src/auth/login.ts', startLine: 9, endLine: 14, exported: true },
    );
    const heuristic = body.edges.find((edge) => edge.resolutionType === 'heuristic')!;
    assert.deepEqual(heuristic.metadata.members, ['send']);
  });
});

describe('GET /api/node/:id/evidence', () => {
  test('returns a symbol\'s own lines with a little context', async () => {
    const { status, body } = await nodeEvidence('sym:src/auth/hash.ts#hashPassword');
    assert.equal(status, 200);
    const [snippet] = body.snippets;
    assert.equal(snippet!.filePath, 'src/auth/hash.ts');
    assert.deepEqual([snippet!.startLine, snippet!.endLine], [3, 5]);
    assert.deepEqual(snippet!.lines.map((line) => line.number), [1, 2, 3, 4, 5]); // context clipped at the file's end
    assert.match(snippet!.lines[2]!.text, /export function hashPassword/);
    assert.equal(snippet!.stale, false);
    assert.equal(snippet!.rule, null);
  });

  test('returns a whole file', async () => {
    const { body } = await nodeEvidence('file:src/index.ts');
    assert.deepEqual(body.snippets[0]!.lines, [{ number: 1, text: "export * from './api/routes';" }]);
    assert.equal(body.snippets[0]!.truncated, false);
  });

  test('shows where an external package is imported', async () => {
    const { body } = await nodeEvidence('ext:npm:bcrypt');
    assert.equal(body.snippets.length, 1);
    assert.equal(body.snippets[0]!.rule, 'ts-morph:import-declaration');
    assert.equal(body.snippets[0]!.lines.find((line) => line.number === 1)!.text, "import bcrypt from 'bcrypt';");
    assert.equal(typeof body.snippets[0]!.edgeId, 'number');
  });

  test('a cluster has no source of its own', async () => {
    const { status, body } = await nodeEvidence('cluster:src/auth');
    assert.equal(status, 200);
    assert.deepEqual(body.snippets, []);
  });

  test('404 for an unknown node', async () => {
    const { status, body } = await nodeEvidence('sym:nope#nothing');
    assert.equal(status, 404);
    assert.match((body as unknown as { error: string }).error, /No node/);
  });
});

describe('GET /api/edge/:id/evidence', () => {
  test('returns the cited lines for an edge', async () => {
    const { body: graph } = await get<GraphResponse>('/api/graph');
    const id = edgeId(graph, 'sym:src/auth/login.ts#login', 'sym:src/auth/hash.ts#hashPassword');
    const { status, body } = await get<EdgeEvidenceResponse>(`/api/edge/${id}/evidence`);
    assert.equal(status, 200);
    assert.equal(body.edge.relation, 'calls');
    const [snippet] = body.snippets;
    assert.equal(snippet!.rule, 'ts-morph:call-expression');
    assert.deepEqual([snippet!.startLine, snippet!.endLine], [12, 12]);
    assert.match(snippet!.lines.find((line) => line.number === 12)!.text, /hashPassword\(/);
  });

  test('marks evidence stale once the cited lines move', async () => {
    const { body: graph } = await get<GraphResponse>('/api/graph');
    const id = edgeId(graph, 'sym:src/notifications/notify.ts#notifyAll', 'sym:src/notifications/notify.ts#Notifier');
    const path = join(root, 'src/notifications/notify.ts');
    const original = readFileSync(path, 'utf8');

    // An edit below the cited line: the file changed, but the evidence still holds.
    writeFileSync(path, `${original}// trailing comment\n`);
    assert.equal((await get<EdgeEvidenceResponse>(`/api/edge/${id}/evidence`)).body.snippets[0]!.stale, false);

    // An edit above it shifts the cited line.
    writeFileSync(path, `// new first line\n${original}`);
    assert.equal((await get<EdgeEvidenceResponse>(`/api/edge/${id}/evidence`)).body.snippets[0]!.stale, true);
    writeFileSync(path, original);
  });

  test('404 for an unknown edge', async () => {
    assert.equal((await get('/api/edge/999999/evidence')).status, 404);
  });
});

describe('POST /api/flow', () => {
  test('finds the call path from a file to an external package', async () => {
    const { status, body } = await post<FlowResponse>('/api/flow', { from: 'file:src/api/routes.ts', to: 'ext:npm:bcrypt' });
    assert.equal(status, 200);
    const routes = body.paths.map((path) => path.nodes.join(' > '));
    assert.ok(
      routes.includes('sym:src/api/routes.ts#handleLogin > sym:src/auth/login.ts#login > sym:src/auth/hash.ts#hashPassword > ext:npm:bcrypt'),
      routes.join('\n'),
    );
    for (const path of body.paths) assert.equal(path.edges.length, path.nodes.length - 1);
  });

  test('can follow only some relations', async () => {
    const { body } = await post<FlowResponse>('/api/flow', { from: 'file:src/api/routes.ts', to: 'ext:npm:bcrypt', relations: ['imports'] });
    assert.deepEqual(body.paths.map((path) => path.nodes), [
      ['file:src/api/routes.ts', 'file:src/auth/login.ts', 'file:src/auth/hash.ts', 'ext:npm:bcrypt'],
    ]);
  });

  test('returns no paths when the target is unreachable', async () => {
    const { body } = await post<FlowResponse>('/api/flow', { from: 'file:src/auth/hash.ts', to: 'file:src/api/routes.ts' });
    assert.deepEqual(body.paths, []);
  });

  test('without `to`, returns everything downstream', async () => {
    const { body } = await post<FlowResponse>('/api/flow', { from: 'sym:src/auth/login.ts#login', relations: ['calls'] });
    assert.deepEqual([...body.reachable!.nodes].sort(), [
      'ext:npm:bcrypt',
      'sym:src/auth/hash.ts#hashPassword',
      'sym:src/auth/login.ts#login',
      'sym:src/db/user-repository.ts#UserRepository',
      'sym:src/db/user-repository.ts#UserRepository.findByEmail',
      'sym:src/db/user-repository.ts#UserRepository.query',
    ]);
  });

  test('rejects bad requests', async () => {
    assert.equal((await post('/api/flow', { to: 'x' })).status, 400);
    assert.equal((await post('/api/flow', { from: 'file:src/index.ts', maxDepth: -1 })).status, 400);
    assert.equal((await post('/api/flow', { from: 'file:src/index.ts' }, 'text/plain')).status, 400);
    assert.equal((await post('/api/flow', { from: 'file:nope.ts' })).status, 404);
  });
});

describe('GET /api/diff', () => {
  test('reports a folder outside git as not a repository', async () => {
    const { status, body } = await get<{ isRepo: boolean; files: unknown[] }>('/api/diff');
    assert.equal(status, 200);
    assert.deepEqual(body, { isRepo: false, base: 'HEAD', files: [], nodeIds: [] });
  });
});

describe('web UI and safety', () => {
  test('serves the page and the bundled client', async () => {
    const page = await fetch(server.url);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'self'/);
    const script = await fetch(`${server.url}/assets/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type')!, /javascript/);
    assert.ok((await script.text()).length > 10_000);
    assert.equal((await fetch(`${server.url}/assets/app.css`)).status, 200);
  });

  test('unknown routes and wrong methods', async () => {
    assert.equal((await fetch(`${server.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/graph`, { method: 'DELETE' })).status, 405);
  });

  test('refuses requests for another host name (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.port, path: '/api/graph', headers: { host: `evil.example:${server.port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
});
