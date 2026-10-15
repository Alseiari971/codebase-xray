// Turns the full evidence graph into what is on screen: a tree of visible
// nodes (collapsed nodes hide their children) and edges rolled up to the
// nearest visible node, so a collapsed cluster shows its files' dependencies.

import type { GraphEdge, GraphNode, GraphResponse, ResolutionType } from '../shared/api-types.ts';

export interface GraphIndex {
  nodes: Map<string, GraphNode>;
  children: Map<string, GraphNode[]>;
  roots: GraphNode[];
  edges: GraphEdge[];
  edgesById: Map<number, GraphEdge>;
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
}

const LAYER_ORDER: Record<string, number> = { cluster: 0, file: 1, symbol: 2, datastore: 3, external: 4 };

function compareNodes(a: GraphNode, b: GraphNode): number {
  return (
    (LAYER_ORDER[a.layer] ?? 9) - (LAYER_ORDER[b.layer] ?? 9) ||
    (a.startLine ?? 0) - (b.startLine ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

export function indexGraph(graph: GraphResponse): GraphIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string, GraphNode[]>();
  const roots: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (node.parentId && nodes.has(node.parentId)) {
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    } else {
      roots.push(node);
    }
  }
  for (const list of children.values()) list.sort(compareNodes);
  roots.sort(compareNodes);

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }

  return { nodes, children, roots, edges: graph.edges, edgesById: new Map(graph.edges.map((e) => [e.id, e])), outgoing, incoming };
}

/** Parent first, root last. */
export function ancestors(index: GraphIndex, id: string): string[] {
  const result: string[] = [];
  for (let current = index.nodes.get(id)?.parentId; current; current = index.nodes.get(current)?.parentId) {
    result.push(current);
  }
  return result;
}

export interface ViewState {
  expanded: ReadonlySet<string>;
  showExternal: boolean;
}

export interface VisibleNode {
  id: string;
  node: GraphNode;
  /** The visible container this node is drawn inside, if any. */
  parent: string | null;
  /** Expanded, so drawn as a box around its children. */
  isContainer: boolean;
  childCount: number;
}

export interface VisibleEdge {
  id: string;
  source: string;
  target: string;
  /** `calls` if any underlying edge is a call, so the strongest dependency sets the style. */
  relation: string;
  /** Every relation among the underlying edges, e.g. ['calls', 'imports']. */
  relations: string[];
  /** The real edges this one stands for. */
  edgeIds: number[];
  /** The weakest resolution among them, so a rolled-up edge never looks more certain than its parts. */
  resolutionType: ResolutionType;
  confidence: number;
  /** How many of `edgeIds` are deterministic; the rest are drawn as uncertain only when none are. */
  deterministicCount: number;
}

export interface GraphView {
  /** Containers always come before their children. */
  nodes: VisibleNode[];
  edges: VisibleEdge[];
  byId: Map<string, VisibleNode>;
  /** The visible node that stands for any graph node (itself or its nearest visible ancestor). */
  representative: (id: string) => string | undefined;
}

const RESOLUTION_STRENGTH: Record<ResolutionType, number> = {
  deterministic: 3,
  runtime_observed: 2,
  heuristic: 1,
  ai_inferred: 0,
};

export function buildView(index: GraphIndex, state: ViewState): GraphView {
  const nodes: VisibleNode[] = [];
  const byId = new Map<string, VisibleNode>();

  const visit = (node: GraphNode, parent: string | null) => {
    const kids = index.children.get(node.id) ?? [];
    const visible: VisibleNode = {
      id: node.id,
      node,
      parent,
      isContainer: kids.length > 0 && state.expanded.has(node.id),
      childCount: kids.length,
    };
    nodes.push(visible);
    byId.set(node.id, visible);
    if (visible.isContainer) for (const kid of kids) visit(kid, node.id);
  };
  for (const root of index.roots) {
    if (root.layer !== 'external' || state.showExternal) visit(root, null);
  }

  const cache = new Map<string, string | undefined>();
  const representative = (id: string): string | undefined => {
    if (!cache.has(id)) {
      let found: string | undefined;
      for (let current: string | null | undefined = id; current; current = index.nodes.get(current)?.parentId) {
        if (byId.has(current)) {
          found = current;
          break;
        }
      }
      cache.set(id, found);
    }
    return cache.get(id);
  };

  const isVisibleAncestor = (ancestor: string, id: string): boolean => {
    for (let current = byId.get(id)?.parent; current; current = byId.get(current)?.parent) {
      if (current === ancestor) return true;
    }
    return false;
  };

  const edges = new Map<string, VisibleEdge>();
  for (const edge of index.edges) {
    const source = representative(edge.source);
    const target = representative(edge.target);
    if (!source || !target || source === target) continue;
    // An edge from a box to something inside it carries no information on screen.
    if (isVisibleAncestor(source, target) || isVisibleAncestor(target, source)) continue;

    // One line per pair of nodes: imports and calls between the same two
    // boxes would otherwise double every edge on screen.
    const key = `${source}\u0000${target}`;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, {
        id: key,
        source,
        target,
        relation: edge.relation,
        relations: [edge.relation],
        edgeIds: [edge.id],
        resolutionType: edge.resolutionType,
        confidence: edge.confidence,
        deterministicCount: edge.resolutionType === 'deterministic' ? 1 : 0,
      });
      continue;
    }
    existing.edgeIds.push(edge.id);
    if (edge.resolutionType === 'deterministic') existing.deterministicCount++;
    if (!existing.relations.includes(edge.relation)) {
      existing.relations = [...existing.relations, edge.relation].sort();
      if (edge.relation === 'calls') existing.relation = 'calls';
    }
    existing.confidence = Math.min(existing.confidence, edge.confidence);
    if (RESOLUTION_STRENGTH[edge.resolutionType] < RESOLUTION_STRENGTH[existing.resolutionType]) {
      existing.resolutionType = edge.resolutionType;
    }
  }

  return { nodes, edges: [...edges.values()], byId, representative };
}

/** Marks every visible node that stands for at least one of `ids`, with how many it stands for. */
export function markVisible(view: GraphView, ids: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const visible = view.representative(id);
    if (visible) counts.set(visible, (counts.get(visible) ?? 0) + 1);
  }
  return counts;
}

/** Case-insensitive match on name, path or qualified symbol; best matches first. */
export function searchNodes(index: GraphIndex, query: string, limit = 12): GraphNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: { node: GraphNode; score: number }[] = [];
  for (const node of index.nodes.values()) {
    const name = node.name.toLowerCase();
    const haystack = `${name} ${node.symbol?.toLowerCase() ?? ''} ${node.path?.toLowerCase() ?? ''}`;
    if (!haystack.includes(needle)) continue;
    const score = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3;
    scored.push({ node, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || compareNodes(a.node, b.node) || a.node.id.localeCompare(b.node.id))
    .slice(0, limit)
    .map((entry) => entry.node);
}
