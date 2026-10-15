import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase, type XrayDb } from '../src/db/database.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import type { DiffResponse, EdgeEvidenceResponse, FlowResponse, GraphResponse } from '../src/shared/api-types.ts';
import { copyFixture, git } from './helpers.ts';

/** A committed copy of the fixture with one uncommitted edit inside hashPassword(). */
function changedFixture(): string {
  const root = copyFixture();
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  const path = join(root, 'src/auth/hash.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replace('hashSync(password, 10)', 'hashSync(password, 12)'));
  return root;
}

// Any JSON shape the tools return.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('MCP server', () => {
  let root: string;
  let db: XrayDb;
  let client: Client;
  let http: RunningServer;

  before(async () => {
    root = changedFixture();
    db = openDatabase(':memory:');
    indexRepository(db, root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ db, root, refreshIntervalMs: 0 }).connect(serverSide);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    // The web UI's API, on the very same index.
    http = await startServer({ db, root, port: 0 });
  });
  after(async () => {
    await client.close();
    await http.close();
    db.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Json> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${http.url}${path}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  };

  test('lists the five read-only tools and explains the shared ids', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_architecture_clusters',
      'get_blast_radius',
      'get_changed_nodes',
      'get_node_evidence',
      'trace_flow',
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }
    assert.match(client.getInstructions() ?? '', /shared with the X-Ray web UI/);
  });

  test('get_architecture_clusters summarises clusters and their dependencies', async () => {
    const result = await call('get_architecture_clusters');
    assert.deepEqual(result.totals, { files: 11, symbols: 12, externals: 3, edges: 22 });
    const api = result.clusters.find((cluster: Json) => cluster.id === 'cluster:src/api');
    assert.deepEqual(api.dependsOn, [{ cluster: 'cluster:src/auth', edges: 2, relations: ['calls', 'imports'] }]);
    assert.deepEqual(api.externals, ['ext:npm:express']);
    const auth = result.clusters.find((cluster: Json) => cluster.id === 'cluster:src/auth');
    assert.deepEqual(auth.externals, ['ext:node:fs', 'ext:npm:bcrypt']);
  });

  test('trace_flow answers a question with entry points, nodes and evidence-backed edges', async () => {
    const result = await call('trace_flow', { question: 'how does login work?' });
    assert.deepEqual(result.question.entryPoints, ['sym:src/api/routes.ts#handleLogin', 'sym:src/ui/LoginForm.tsx#LoginForm']);
    const login = result.nodes.find((node: Json) => node.id === 'sym:src/auth/login.ts#login');
    assert.deepEqual(login, { id: 'sym:src/auth/login.ts#login', layer: 'symbol', type: 'function', name: 'login', path: 'src/auth/login.ts', lines: '9-14' });
    const toHash = result.edges.find((edge: Json) => edge.target === 'sym:src/auth/hash.ts#hashPassword');
    assert.equal(toHash.resolutionType, 'deterministic');
    assert.equal(toHash.evidence[0].at, 'src/auth/login.ts:12');
    assert.equal(toHash.evidence[0].rule, 'ts-morph:call-expression');
  });

  test('trace_flow between two names finds the path', async () => {
    const result = await call('trace_flow', { from: 'handleLogin', to: 'bcrypt', relations: ['calls'] });
    assert.deepEqual(result.paths[0].nodes, [
      'sym:src/api/routes.ts#handleLogin',
      'sym:src/auth/login.ts#login',
      'sym:src/auth/hash.ts#hashPassword',
      'ext:npm:bcrypt',
    ]);
  });

  test('get_blast_radius resolves a symbol name and groups by file', async () => {
    const result = await call('get_blast_radius', { target: 'hashPassword' });
    assert.equal(result.target.id, 'sym:src/auth/hash.ts#hashPassword');
    assert.deepEqual(result.files.map((file: Json) => `${file.depth} ${file.path}`), ['1 src/auth/login.ts', '2 src/api/routes.ts', '3 src/api/server.js']);
  });

  test('get_node_evidence returns numbered source and evidence-backed edges', async () => {
    const result = await call('get_node_evidence', { target: 'src/auth/hash.ts' });
    assert.equal(result.node.id, 'file:src/auth/hash.ts');
    assert.match(result.source[0].code, /^3\| export function hashPassword/m);
    assert.deepEqual(result.children, ['sym:src/auth/hash.ts#hashPassword']);
    assert.deepEqual(result.incoming.map((edge: Json) => edge.source), ['file:src/auth/login.ts']);
    assert.equal(typeof result.incoming[0].evidence[0].id, 'number');
  });

  test('get_changed_nodes maps the uncommitted edit and its blast radius', async () => {
    const result = await call('get_changed_nodes');
    assert.deepEqual(result.files.map((file: Json) => [file.path, file.status, file.changedLines]), [['src/auth/hash.ts', 'modified', ['4']]]);
    assert.deepEqual(result.files[0].symbols.map((symbol: Json) => symbol.id), ['sym:src/auth/hash.ts#hashPassword']);
    assert.deepEqual(result.impact.nodes.map((node: Json) => node.id), [
      'sym:src/auth/login.ts#login',
      'sym:src/api/routes.ts#handleLogin',
      'file:src/api/server.js',
    ]);
  });

  test('errors come back as tool errors, not crashes', async () => {
    await assert.rejects(call('get_blast_radius', { target: 'nothingLikeThis' }), /No file, symbol, package or node named/);
    await assert.rejects(call('get_node_evidence', {}), /Pass `target` or `edgeId`/);
    await assert.rejects(call('get_node_evidence', { edgeId: 99999 }), /No edge with id/);
    await assert.rejects(call('trace_flow', { question: 'how does it work?' }), /no searchable words/);
  });

  describe('shared truth with the web UI', () => {
    test('trace_flow returns the same node and edge ids as POST /api/flow', async () => {
      const mcp = await call('trace_flow', { question: 'how does login work?' });
      const web = await api<FlowResponse>('/api/flow', { question: 'how does login work?' });
      assert.deepEqual(mcp.nodes.map((node: Json) => node.id).sort(), [...web.reachable!.nodes].sort());
      assert.deepEqual(mcp.edges.map((edge: Json) => edge.id).sort(), [...web.reachable!.edges].sort());
    });

    test('evidence ids match GET /api/edge/:id/evidence, and edges match GET /api/graph', async () => {
      const graph = await api<GraphResponse>('/api/graph');
      const edge = graph.edges.find((e) => e.source === 'sym:src/auth/login.ts#login' && e.target === 'sym:src/auth/hash.ts#hashPassword')!;
      const mcp = await call('get_node_evidence', { edgeId: edge.id });
      const web = await api<EdgeEvidenceResponse>(`/api/edge/${edge.id}/evidence`);
      assert.deepEqual(mcp.evidence.map((item: Json) => item.evidenceId), web.snippets.map((snippet) => snippet.evidenceId));
      assert.equal(mcp.edge.source.id, edge.source);
      assert.equal(mcp.edge.resolutionType, edge.resolutionType);
    });

    test('get_changed_nodes flags the same nodes and impact as GET /api/diff', async () => {
      const mcp = await call('get_changed_nodes');
      const web = await api<DiffResponse>('/api/diff');
      assert.deepEqual(mcp.files.flatMap((file: Json) => [file.nodeId, ...file.symbols.map((s: Json) => s.id)]), web.nodeIds);
      assert.deepEqual(mcp.impact.nodes.map((node: Json) => node.id), web.impact.nodes.map((node) => node.id));
      assert.deepEqual(mcp.impact.edges, web.impact.edges);
    });
  });
});

test('xray mcp serves the tools over stdio and indexes on start', async () => {
  const root = changedFixture(); // never indexed
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, '..', 'bin', 'xray.js'), 'mcp', root],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'get_blast_radius', arguments: { target: 'login' } });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.deepEqual(parsed.files.map((file: Json) => file.path), ['src/api/routes.ts', 'src/api/server.js']);
  } finally {
    await client.close();
  }
});

test('the server re-indexes before answering, so edits show up immediately', async () => {
  const root = changedFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ db, root, refreshIntervalMs: 1 }).connect(serverSide);
  const client = new Client({ name: 'refresh', version: '0' });
  await client.connect(clientSide);
  try {
    writeFileSync(join(root, 'src/auth/otp.ts'), "import { hashPassword } from './hash';\nexport const otp = () => hashPassword('123456');\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await client.callTool({ name: 'get_blast_radius', arguments: { target: 'hashPassword' } });
    const parsed = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.ok(parsed.files.some((file: Json) => file.path === 'src/auth/otp.ts'));
  } finally {
    await client.close();
    db.close();
  }
});
