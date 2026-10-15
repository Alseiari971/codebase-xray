import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode, GraphResponse } from '../src/shared/api-types.ts';
import { CONTAINER_HEADER, CONTAINER_PADDING, layoutView } from '../src/web/layout.ts';
import { ancestors, buildView, indexGraph, markVisible, searchNodes } from '../src/web/model.ts';

function node(id: string, layer: GraphNode['layer'], parentId: string | null = null, name = id.split(/[:/#]/).at(-1)!): GraphNode {
  return { id, parentId, layer, type: layer, name, path: null, symbol: null, language: null, startLine: null, endLine: null, metadata: {} };
}

let nextEdge = 1;
function edge(source: string, target: string, relation = 'calls', resolutionType: GraphEdge['resolutionType'] = 'deterministic', confidence = 1): GraphEdge {
  return { id: nextEdge++, source, target, relation, resolutionType, confidence, metadata: {} };
}

// Two clusters, three files, symbols in two of them, and one package.
const graph: GraphResponse = {
  root: '/repo',
  indexedAt: null,
  nodes: [
    node('cluster:api', 'cluster'),
    node('cluster:db', 'cluster'),
    node('file:api/routes.ts', 'file', 'cluster:api'),
    node('file:api/auth.ts', 'file', 'cluster:api'),
    node('file:db/repo.ts', 'file', 'cluster:db'),
    node('sym:api/routes.ts#handle', 'symbol', 'file:api/routes.ts'),
    node('sym:api/auth.ts#login', 'symbol', 'file:api/auth.ts'),
    node('sym:db/repo.ts#Repo', 'symbol', 'file:db/repo.ts'),
    node('sym:db/repo.ts#Repo.find', 'symbol', 'sym:db/repo.ts#Repo'),
    node('ext:npm:pg', 'external'),
  ],
  edges: [
    edge('file:api/routes.ts', 'file:api/auth.ts', 'imports'),
    edge('sym:api/routes.ts#handle', 'sym:api/auth.ts#login'),
    edge('sym:api/auth.ts#login', 'sym:db/repo.ts#Repo.find'),
    edge('sym:api/routes.ts#handle', 'sym:db/repo.ts#Repo', 'calls', 'heuristic', 0.7),
    edge('file:db/repo.ts', 'ext:npm:pg', 'imports'),
    // Module top level calling into its own symbol.
    edge('file:api/auth.ts', 'sym:api/auth.ts#login'),
  ],
};
const index = indexGraph(graph);
const view = (expanded: string[], showExternal = false) => buildView(index, { expanded: new Set(expanded), showExternal });
const edgeSummary = (v: ReturnType<typeof view>) =>
  v.edges.map((e) => `${e.source} -${e.relation}-> ${e.target} x${e.edgeIds.length} ${e.resolutionType} ${e.confidence}`).sort();

test('collapsed clusters roll every edge up to the cluster level', () => {
  const v = view([]);
  assert.deepEqual(v.nodes.map((n) => n.id), ['cluster:api', 'cluster:db']);
  // The heuristic edge makes the whole rolled-up edge heuristic: never more certain than its weakest part.
  assert.deepEqual(edgeSummary(v), ['cluster:api -calls-> cluster:db x2 heuristic 0.7']);
  assert.equal(v.edges[0]!.deterministicCount, 1);
});

test('expanding a cluster shows its files and re-targets the edges', () => {
  const v = view(['cluster:api']);
  assert.deepEqual(v.nodes.map((n) => `${n.id}${n.isContainer ? ' [box]' : ''} in ${n.parent}`), [
    'cluster:api [box] in null',
    'file:api/auth.ts in cluster:api',
    'file:api/routes.ts in cluster:api',
    'cluster:db in null',
  ]);
  assert.deepEqual(edgeSummary(v), [
    'file:api/auth.ts -calls-> cluster:db x1 deterministic 1',
    'file:api/routes.ts -calls-> cluster:db x1 heuristic 0.7',
    // An import and a call between the same two files share one line.
    'file:api/routes.ts -calls-> file:api/auth.ts x2 deterministic 1',
  ]);
  const shared = v.edges.find((e) => e.source === 'file:api/routes.ts' && e.target === 'file:api/auth.ts')!;
  assert.deepEqual(shared.relations, ['calls', 'imports']);
});

test('edges between a box and its own contents are dropped', () => {
  const v = view(['cluster:api', 'file:api/auth.ts']);
  assert.ok(!v.edges.some((e) => e.source === 'file:api/auth.ts' && e.target === 'sym:api/auth.ts#login'));
  assert.ok(v.edges.some((e) => e.source === 'file:api/routes.ts' && e.target === 'sym:api/auth.ts#login'));
});

test('external nodes are hidden unless asked for', () => {
  assert.ok(!view(['cluster:db']).nodes.some((n) => n.id === 'ext:npm:pg'));
  const withExternal = view(['cluster:db'], true);
  assert.ok(withExternal.edges.some((e) => e.source === 'file:db/repo.ts' && e.target === 'ext:npm:pg'));
});

test('representative and markVisible map hidden nodes to what is on screen', () => {
  const v = view(['cluster:db']);
  assert.equal(v.representative('sym:db/repo.ts#Repo.find'), 'file:db/repo.ts');
  assert.equal(v.representative('sym:api/auth.ts#login'), 'cluster:api');
  assert.equal(v.representative('ext:npm:pg'), undefined);
  assert.deepEqual(
    [...markVisible(v, ['sym:api/auth.ts#login', 'sym:api/routes.ts#handle', 'sym:db/repo.ts#Repo'])].sort(),
    [['cluster:api', 2], ['file:db/repo.ts', 1]],
  );
});

test('ancestors lists the path up to the root', () => {
  assert.deepEqual(ancestors(index, 'sym:db/repo.ts#Repo.find'), ['sym:db/repo.ts#Repo', 'file:db/repo.ts', 'cluster:db']);
  assert.deepEqual(ancestors(index, 'cluster:db'), []);
});

test('search ranks exact name matches, then prefixes, then substrings', () => {
  assert.deepEqual(searchNodes(index, 'repo').map((n) => n.id), [
    'sym:db/repo.ts#Repo', // name is exactly "Repo"
    'file:db/repo.ts', // prefix; files sort before symbols
    'sym:db/repo.ts#Repo.find',
  ]);
  assert.deepEqual(searchNodes(index, 'uth').map((n) => n.id), ['file:api/auth.ts']);
  assert.deepEqual(searchNodes(index, '   '), []);
});

test('layout places children inside their container without overlaps', () => {
  const v = view(['cluster:api', 'cluster:db', 'file:db/repo.ts', 'sym:db/repo.ts#Repo']);
  const boxes = layoutView(v);
  assert.equal(boxes.size, v.nodes.length);

  for (const visible of v.nodes) {
    const box = boxes.get(visible.id)!;
    if (!visible.parent) continue;
    const parent = boxes.get(visible.parent)!;
    // Child coordinates are relative to the parent box.
    assert.ok(box.x >= CONTAINER_PADDING - 0.5 && box.y >= CONTAINER_HEADER - 0.5, `${visible.id} starts inside ${visible.parent}`);
    assert.ok(box.x + box.width <= parent.width + 0.5 && box.y + box.height <= parent.height + 0.5, `${visible.id} ends inside ${visible.parent}`);
  }

  const siblings = new Map<string | null, string[]>();
  for (const visible of v.nodes) siblings.set(visible.parent, [...(siblings.get(visible.parent) ?? []), visible.id]);
  for (const ids of siblings.values()) {
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const p = boxes.get(a)!;
        const q = boxes.get(b)!;
        const overlap = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
        assert.ok(!overlap, `${a} overlaps ${b}`);
      }
    }
  }
});
