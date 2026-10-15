// Nested layout: each expanded container lays out its own children with dagre,
// bottom-up, so a container's size is known before its parent is laid out.
// This avoids dagre's compound-graph mode, which cannot route edges to boxes.

import dagre from '@dagrejs/dagre';
import type { GraphView, VisibleNode } from './model.ts';

export interface Box {
  /** Relative to the containing box's top-left corner, or absolute at the top level. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Flow direction of the level this box sits in; edges attach to match. */
  direction: 'LR' | 'TB';
}

export const NODE_HEIGHT = 44;
/** A collapsed cluster that shows its top functions inside the box. */
export const PREVIEW_HEIGHT = 72;
const PREVIEW_MIN_WIDTH = 250;
export const CONTAINER_HEADER = 40;
export const CONTAINER_PADDING = 16;
const GAP = 20;
/** Levels up to this size switch to a grid when densely linked. */
const DENSE_MAX_NODES = 40;
/** Beyond this many nodes, ranks are unreadable anyway; a grid keeps the level compact. */
const LARGE_LEVEL = 80;
/** Width / height that fits a typical screen next to the evidence panel. */
const TARGET_ASPECT = 1.6;

/** Room for the toggle, kind label, name and a badge. */
export function leafWidth(node: VisibleNode): number {
  const kind = node.node.layer === 'symbol' ? node.node.type : node.node.layer;
  return Math.min(340, Math.max(160, (node.node.name.length + kind.length) * 7 + 110));
}

export function layoutView(view: GraphView, hasPreview: (node: VisibleNode) => boolean = () => false): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const childrenOf = new Map<string | null, VisibleNode[]>();
  for (const node of view.nodes) childrenOf.set(node.parent, [...(childrenOf.get(node.parent) ?? []), node]);

  // Each edge is laid out at the level of the deepest container holding both
  // ends, between the two children of that container that contain the ends.
  const chain = (id: string): string[] => {
    const result: string[] = [];
    for (let current: string | null | undefined = id; current; current = view.byId.get(current)?.parent) result.unshift(current);
    return result;
  };
  const levelEdges = new Map<string | null, [string, string][]>();
  for (const edge of view.edges) {
    const from = chain(edge.source);
    const to = chain(edge.target);
    let depth = 0;
    while (depth < from.length && depth < to.length && from[depth] === to[depth]) depth++;
    const a = from[depth];
    const b = to[depth];
    if (!a || !b) continue;
    const container = depth === 0 ? null : from[depth - 1]!;
    levelEdges.set(container, [...(levelEdges.get(container) ?? []), [a, b]]);
  }

  const layoutLevel = (container: string | null): { width: number; height: number } => {
    const children = childrenOf.get(container) ?? [];
    const sizes = new Map<string, { width: number; height: number }>();
    for (const child of children) {
      if (child.isContainer) {
        const content = layoutLevel(child.id);
        sizes.set(child.id, {
          width: Math.max(leafWidth(child), content.width + CONTAINER_PADDING * 2),
          height: content.height + CONTAINER_HEADER + CONTAINER_PADDING,
        });
      } else {
        sizes.set(
          child.id,
          hasPreview(child)
            ? { width: Math.max(leafWidth(child), PREVIEW_MIN_WIDTH), height: PREVIEW_HEIGHT }
            : { width: leafWidth(child), height: NODE_HEIGHT },
        );
      }
    }

    const edges = levelEdges.get(container) ?? [];
    const connected = new Set(edges.flat());
    const linked = children.filter((child) => connected.has(child.id));
    const isolated = children.filter((child) => !connected.has(child.id));

    let width = 0;
    let height = 0;

    // Packs nodes left to right into rows that wrap so the block comes out
    // roughly TARGET_ASPECT wide, using each node's real size.
    const packRows = (nodes: VisibleNode[], top: number, gapX: number, gapY: number, minRowWidth: number) => {
      const area = nodes.reduce((sum, node) => {
        const size = sizes.get(node.id)!;
        return sum + (size.width + gapX) * (size.height + gapY);
      }, 0);
      const widest = Math.max(0, ...nodes.map((node) => sizes.get(node.id)!.width));
      const rowLimit = Math.max(minRowWidth, widest, Math.sqrt(area * TARGET_ASPECT));
      let x = 0;
      let y = top;
      let rowHeight = 0;
      for (const node of nodes) {
        const size = sizes.get(node.id)!;
        if (x > 0 && x + size.width > rowLimit) {
          x = 0;
          y += rowHeight + gapY;
          rowHeight = 0;
        }
        boxes.set(node.id, { x, y, ...size, direction: 'LR' });
        x += size.width + gapX;
        rowHeight = Math.max(rowHeight, size.height);
        width = Math.max(width, x - gapX);
        height = Math.max(height, y + size.height);
      }
    };

    const pairs = new Set(edges.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`))).size;
    const dense = linked.length <= DENSE_MAX_NODES && pairs > linked.length * 2;
    if (linked.length > 0 && (dense || linked.length > LARGE_LEVEL)) {
      // Nearly everything talks to everything, or there are too many nodes for
      // ranks to help: pack them compactly, with room between rows for edges.
      packRows(linked, 0, GAP * 4, GAP * 5, 0);
    } else if (linked.length > 0) {
      const run = (rankdir: 'LR' | 'TB') => {
        const graph = new dagre.graphlib.Graph();
        graph.setGraph({ rankdir, nodesep: GAP, ranksep: 64, marginx: 0, marginy: 0 });
        graph.setDefaultEdgeLabel(() => ({}));
        for (const child of linked) graph.setNode(child.id, { ...sizes.get(child.id)! });
        for (const [a, b] of edges) graph.setEdge(a, b);
        dagre.layout(graph);
        const { width: w = 1, height: h = 1 } = graph.graph();
        return { graph, rankdir, misfit: Math.abs(Math.log(w / h / TARGET_ASPECT)) };
      };
      // Chains of dependencies come out long and thin; keep whichever
      // direction gives a shape closer to a landscape screen.
      const across = run('LR');
      const best = across.misfit < Math.log(2) ? across : [across, run('TB')].sort((a, b) => a.misfit - b.misfit)[0]!;
      for (const child of linked) {
        const placed = best.graph.node(child.id);
        const size = sizes.get(child.id)!;
        const box = { x: placed.x - size.width / 2, y: placed.y - size.height / 2, ...size, direction: best.rankdir };
        boxes.set(child.id, box);
        width = Math.max(width, box.x + box.width);
        height = Math.max(height, box.y + box.height);
      }
    }

    // Unconnected nodes go in rows below, instead of one endless dagre column.
    if (isolated.length > 0) packRows(isolated, linked.length > 0 ? height + GAP * 2 : 0, GAP, GAP, Math.max(width, 320));

    // Children of a container are positioned inside its padding and header.
    if (container !== null) {
      for (const child of children) {
        const box = boxes.get(child.id)!;
        box.x += CONTAINER_PADDING;
        box.y += CONTAINER_HEADER;
      }
    }
    return { width, height };
  };

  layoutLevel(null);
  return boxes;
}
