// Small, flat views for reading code rather than surveying it: the
// neighbourhood of one node (Focus) and the nodes of one result (Trace).
// Both are laid out left to right, callers before callees, with nothing else
// on screen.

import dagre from '@dagrejs/dagre';
import type { GraphNode } from '../shared/api-types.ts';
import { rollUpEdge, type GraphIndex, type VisibleEdge } from './model.ts';

export type FlatRole = 'center' | 'upstream' | 'downstream' | 'member';

export interface FlatNode {
  id: string;
  node: GraphNode;
  role: FlatRole;
  /** Hops from the focused node; 0 for the focus itself and trace nodes. */
  depth: number;
  /** When a crowded side was rolled up to files, how many nodes this stands for. */
  members: number;
}

export interface FlatView {
  nodes: FlatNode[];
  edges: VisibleEdge[];
  /** The view node that stands for any graph node (itself or an ancestor shown in the view). */
  representative: (id: string) => string | undefined;
  /** Neighbours per side, before any rolling up. */
  counts: { upstream: number; downstream: number };
}

export interface FocusOptions {
  depth: number;
  relations: string[];
  /** Beyond this many neighbours on one side, show their files instead. */
  maxPerSide?: number;
}

export function subtreeIds(index: GraphIndex, id: string): Set<string> {
  const ids = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const child of index.children.get(stack.pop()!) ?? []) {
      ids.add(child.id);
      stack.push(child.id);
    }
  }
  return ids;
}

/** The nearest ancestor-or-self at the given layers (a symbol's file, a file's cluster). */
function ancestorAt(index: GraphIndex, id: string, layers: string[]): string {
  for (let current: string | null | undefined = id; current; current = index.nodes.get(current)?.parentId) {
    if (layers.includes(index.nodes.get(current)!.layer)) return current;
  }
  return id;
}

/**
 * The focused node with what depends on it (left) and what it depends on
 * (right), `depth` hops each way. A file or cluster stands for everything
 * inside it. A side with too many neighbours is rolled up to their files, then
 * clusters, so the view stays readable.
 */
export function focusView(index: GraphIndex, id: string, options: FocusOptions): FlatView {
  const maxPerSide = options.maxPerSide ?? 24;
  const inside = subtreeIds(index, id);
  const rep = new Map<string, string>([...inside].map((member) => [member, id]));
  const roles = new Map<string, { role: FlatRole; depth: number; members: Set<string> }>([[id, { role: 'center', depth: 0, members: new Set([id]) }]]);
  const edges = new Map<string, VisibleEdge>();
  const counts = { upstream: 0, downstream: 0 };

  for (const side of ['upstream', 'downstream'] as const) {
    let frontier = new Set(inside);
    const seen = new Set(inside);
    for (let depth = 1; depth <= options.depth && frontier.size > 0; depth++) {
      // Real edges crossing from the frontier to nodes not seen yet.
      const found: { edge: (typeof index.edges)[number]; neighbour: string; from: string }[] = [];
      for (const member of frontier) {
        const list = side === 'upstream' ? index.incoming.get(member) : index.outgoing.get(member);
        for (const edge of list ?? []) {
          if (!options.relations.includes(edge.relation)) continue;
          const neighbour = side === 'upstream' ? edge.source : edge.target;
          // Only new nodes: each neighbour sits at the depth it was first reached.
          if (seen.has(neighbour)) continue;
          found.push({ edge, neighbour, from: member });
        }
      }
      const neighbours = [...new Set(found.map((item) => item.neighbour))];
      if (depth === 1) counts[side] = neighbours.length;

      // Too many to read: show their files, and if still too many, their clusters.
      let level = (neighbour: string) => neighbour;
      if (neighbours.length > maxPerSide) {
        const byFile = (neighbour: string) => ancestorAt(index, neighbour, ['file', 'external']);
        level = new Set(neighbours.map(byFile)).size > maxPerSide ? (n) => ancestorAt(index, n, ['cluster', 'external']) : byFile;
      }

      const next = new Set<string>();
      for (const { edge, neighbour, from } of found) {
        const shown = rep.get(neighbour) ?? level(neighbour);
        rep.set(neighbour, shown);
        if (!roles.has(shown)) roles.set(shown, { role: side, depth, members: new Set() });
        roles.get(shown)!.members.add(neighbour);
        const near = rep.get(from)!;
        if (shown === near) continue;
        if (side === 'upstream') rollUpEdge(edges, shown, near, edge);
        else rollUpEdge(edges, near, shown, edge);
        seen.add(neighbour);
        next.add(neighbour);
      }
      frontier = next;
    }
  }

  const nodes = [...roles].flatMap(([nodeId, info]) => {
    const node = index.nodes.get(nodeId);
    return node ? [{ id: nodeId, node, role: info.role, depth: info.depth, members: info.members.size }] : [];
  });
  return { nodes: sortFlat(nodes), edges: [...edges.values()], representative: (any) => rep.get(any) ?? representativeIn(index, roles, any), counts };
}

/**
 * Exactly the given nodes and edges, e.g. a traced feature, a blast radius or a
 * reviewed diff. Edge ends outside the set are drawn on their nearest ancestor
 * in the set (a symbol inside a seeded file), or dropped.
 */
export function subgraphView(index: GraphIndex, nodeIds: Iterable<string>, edgeIds: Iterable<number>): FlatView {
  const ids = new Set([...nodeIds].filter((id) => index.nodes.has(id)));
  const roles = new Map([...ids].map((id) => [id, { role: 'member' as FlatRole, depth: 0, members: new Set([id]) }]));
  const representative = (id: string) => representativeIn(index, roles, id);
  const edges = new Map<string, VisibleEdge>();
  for (const edgeId of edgeIds) {
    const edge = index.edgesById.get(edgeId);
    if (!edge) continue;
    const source = representative(edge.source);
    const target = representative(edge.target);
    if (source && target && source !== target) rollUpEdge(edges, source, target, edge);
  }
  const nodes = [...ids].map((id) => ({ id, node: index.nodes.get(id)!, role: 'member' as FlatRole, depth: 0, members: 1 }));
  return { nodes: sortFlat(nodes), edges: [...edges.values()], representative, counts: { upstream: 0, downstream: 0 } };
}

function representativeIn(index: GraphIndex, shown: Map<string, unknown>, id: string): string | undefined {
  for (let current: string | null | undefined = id; current; current = index.nodes.get(current)?.parentId) {
    if (shown.has(current)) return current;
  }
  return undefined;
}

function sortFlat(nodes: FlatNode[]): FlatNode[] {
  return nodes.sort((a, b) => (a.node.path ?? '').localeCompare(b.node.path ?? '') || (a.node.startLine ?? 0) - (b.node.startLine ?? 0) || a.id.localeCompare(b.id));
}

export interface FlatBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CARD_HEIGHT = 60;

export function cardWidth(node: FlatNode): number {
  const label = node.node.symbol ?? node.node.name;
  const sub = node.node.path ?? '';
  return Math.min(360, Math.max(190, Math.max(label.length * 8.2, sub.length * 6.4) + 40));
}

/** Width / height that suits a screen next to the evidence panel. */
const TARGET_ASPECT = 1.6;

/**
 * Left to right: callers, then the focus, then what it calls. Cards with no
 * edges in the view (e.g. changed symbols nothing else uses) go in a grid
 * below, in file order, instead of one endless column.
 */
export function layoutFlat(view: FlatView): Map<string, FlatBox> {
  const linked = new Set(view.edges.flatMap((edge) => [edge.source, edge.target]));
  const boxes = new Map<string, FlatBox>();
  let bottom = 0;
  let right = 0;

  const connected = view.nodes.filter((node) => linked.has(node.id));
  if (connected.length > 0) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 16, ranksep: 110, marginx: 0, marginy: 0 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of connected) graph.setNode(node.id, { width: cardWidth(node), height: CARD_HEIGHT });
    for (const edge of view.edges) graph.setEdge(edge.source, edge.target);
    dagre.layout(graph);
    for (const node of connected) {
      const placed = graph.node(node.id);
      const width = cardWidth(node);
      const box = { x: placed.x - width / 2, y: placed.y - CARD_HEIGHT / 2, width, height: CARD_HEIGHT };
      boxes.set(node.id, box);
      bottom = Math.max(bottom, box.y + box.height);
      right = Math.max(right, box.x + box.width);
    }
  }

  const loose = view.nodes.filter((node) => !linked.has(node.id));
  if (loose.length > 0) {
    const column = Math.max(...loose.map(cardWidth)) + 24;
    const row = CARD_HEIGHT + 16;
    const columns = Math.max(1, Math.round(Math.sqrt((TARGET_ASPECT * loose.length * row) / column)), Math.floor(right / column));
    const top = connected.length > 0 ? bottom + 60 : 0;
    loose.forEach((node, i) => {
      boxes.set(node.id, { x: (i % columns) * column, y: top + Math.floor(i / columns) * row, width: cardWidth(node), height: CARD_HEIGHT });
    });
  }
  return boxes;
}
