import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode, GraphResponse } from '../src/shared/api-types.ts';
import { focusView, layoutFlat, subgraphView } from '../src/web/focus.ts';
import { indexGraph } from '../src/web/model.ts';

function node(id: string, layer: GraphNode['layer'], parentId: string | null = null): GraphNode {
  return { id, parentId, layer, type: layer === 'symbol' ? 'function' : layer, name: id.split(/[:/#]/).at(-1)!, path: null, symbol: null, language: null, startLine: null, endLine: null, metadata: {} };
}

let nextEdge = 1;
const edge = (source: string, target: string, relation = 'calls'): GraphEdge => ({
  id: nextEdge++, source, target, relation, resolutionType: 'deterministic', confidence: 1, metadata: {},
});

// route -> handler -> service -> repo -> db; job also calls service; service imports a package.
const graph: GraphResponse = {
  root: '/repo',
  indexedAt: null,
  nodes: [
    node('cluster:app', 'cluster'),
    node('file:app/api.ts', 'file', 'cluster:app'),
    node('file:app/service.ts', 'file', 'cluster:app'),
    node('sym:app/api.ts#route', 'symbol', 'file:app/api.ts'),
    node('sym:app/api.ts#handler', 'symbol', 'file:app/api.ts'),
    node('sym:app/api.ts#job', 'symbol', 'file:app/api.ts'),
    node('sym:app/service.ts#service', 'symbol', 'file:app/service.ts'),
    node('sym:app/service.ts#repo', 'symbol', 'file:app/service.ts'),
    node('sym:app/service.ts#db', 'symbol', 'file:app/service.ts'),
    node('ext:npm:pg', 'external'),
  ],
  edges: [
    edge('sym:app/api.ts#route', 'sym:app/api.ts#handler'),
    edge('sym:app/api.ts#handler', 'sym:app/service.ts#service'),
    edge('sym:app/api.ts#job', 'sym:app/service.ts#service'),
    edge('sym:app/service.ts#service', 'sym:app/service.ts#repo'),
    edge('sym:app/service.ts#repo', 'sym:app/service.ts#db'),
    edge('file:app/service.ts', 'ext:npm:pg', 'imports'),
    edge('file:app/api.ts', 'file:app/service.ts', 'imports'),
  ],
};
const index = indexGraph(graph);
const ids = (view: { nodes: { id: string; role: string; depth: number }[] }) =>
  view.nodes.map((n) => `${n.role}:${n.depth} ${n.id}`).sort();

test('focus shows callers on one side and dependencies on the other', () => {
  const view = focusView(index, 'sym:app/service.ts#service', { depth: 1, relations: ['calls', 'imports'] });
  assert.deepEqual(ids(view), [
    'center:0 sym:app/service.ts#service',
    'downstream:1 sym:app/service.ts#repo',
    'upstream:1 sym:app/api.ts#handler',
    'upstream:1 sym:app/api.ts#job',
  ]);
  assert.deepEqual(view.counts, { upstream: 2, downstream: 1 });
  assert.deepEqual(view.edges.map((e) => `${e.source} -> ${e.target}`).sort(), [
    'sym:app/api.ts#handler -> sym:app/service.ts#service',
    'sym:app/api.ts#job -> sym:app/service.ts#service',
    'sym:app/service.ts#service -> sym:app/service.ts#repo',
  ]);
});

test('depth 2 adds the next ring, each node at the depth it was first reached', () => {
  const view = focusView(index, 'sym:app/service.ts#service', { depth: 2, relations: ['calls'] });
  assert.deepEqual(ids(view), [
    'center:0 sym:app/service.ts#service',
    'downstream:1 sym:app/service.ts#repo',
    'downstream:2 sym:app/service.ts#db',
    'upstream:1 sym:app/api.ts#handler',
    'upstream:1 sym:app/api.ts#job',
    'upstream:2 sym:app/api.ts#route',
  ]);
});

test('focusing a file uses everything inside it, and leaves out what is inside', () => {
  const view = focusView(index, 'file:app/service.ts', { depth: 1, relations: ['calls', 'imports'] });
  assert.deepEqual(ids(view), [
    'center:0 file:app/service.ts',
    'downstream:1 ext:npm:pg',
    'upstream:1 file:app/api.ts',
    'upstream:1 sym:app/api.ts#handler',
    'upstream:1 sym:app/api.ts#job',
  ]);
  assert.equal(view.representative('sym:app/service.ts#repo'), 'file:app/service.ts');
});

test('a crowded side is rolled up to files', () => {
  const view = focusView(index, 'sym:app/service.ts#service', { depth: 1, relations: ['calls'], maxPerSide: 1 });
  const upstream = view.nodes.filter((n) => n.role === 'upstream');
  assert.deepEqual(upstream.map((n) => [n.id, n.members]), [['file:app/api.ts', 2]]);
  assert.equal(view.edges.find((e) => e.source === 'file:app/api.ts')!.edgeIds.length, 2);
});

test('a subgraph shows exactly the given nodes, attaching inner edge ends to their container', () => {
  const view = subgraphView(index, ['file:app/api.ts', 'sym:app/service.ts#service'], [2, 3, 999]);
  assert.deepEqual(view.nodes.map((n) => n.id), ['file:app/api.ts', 'sym:app/service.ts#service']);
  assert.deepEqual(view.edges.map((e) => [e.source, e.target, e.edgeIds.length]), [['file:app/api.ts', 'sym:app/service.ts#service', 2]]);
});

test('flat layout keeps cards apart and puts unconnected ones in a grid', () => {
  const view = subgraphView(
    index,
    graph.nodes.filter((n) => n.layer === 'symbol').map((n) => n.id),
    [1], // only route -> handler is connected
  );
  const boxes = layoutFlat(view);
  assert.equal(boxes.size, 6);
  const all = [...boxes.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, b] = [all[i]!, all[j]!];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `cards ${i} and ${j} overlap`);
    }
  }
  // The four unconnected cards do not form a single column.
  const loose = ['sym:app/api.ts#job', 'sym:app/service.ts#service', 'sym:app/service.ts#repo', 'sym:app/service.ts#db'];
  assert.ok(new Set(loose.map((id) => boxes.get(id)!.x)).size > 1);
});
