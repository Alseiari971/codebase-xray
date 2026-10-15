import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, useEffect, useMemo, useRef } from 'react';
import type { GraphView, VisibleEdge, VisibleNode } from './model.ts';
import { layoutView } from './layout.ts';

export interface Highlights {
  selectedNode: string | null;
  selectedEdge: string | null;
  /** Visible node id -> number of changed nodes it stands for. */
  changed: Map<string, number>;
  /** Visible node id -> number of impacted (blast radius) nodes it stands for. */
  impacted: Map<string, number>;
  impactEdges: Set<number>;
  flowNodes: Map<string, number>;
  flowEdges: Set<number>;
  flowEnds: { from: string | null; to: string | null; entries: Set<string> };
}

interface XNodeData extends Record<string, unknown> {
  visible: VisibleNode;
  changed: number;
  impacted: number;
  inFlow: boolean;
  flowEnd: 'from' | 'to' | 'entry' | null;
  direction: 'LR' | 'TB';
  onToggle: (id: string) => void;
}

const LAYER_LABEL: Record<string, string> = {
  cluster: 'cluster',
  file: 'file',
  symbol: 'symbol',
  external: 'external',
  datastore: 'data',
};

const XNode = memo(function XNode({ data, selected }: NodeProps<Node<XNodeData>>) {
  const { visible, changed, impacted, inFlow, flowEnd, direction, onToggle } = data;
  const vertical = direction === 'TB';
  const { node } = visible;
  const classes = [
    'xnode',
    `layer-${node.layer}`,
    visible.isContainer ? 'is-container' : 'is-leaf',
    selected ? 'is-selected' : '',
    changed > 0 ? 'is-changed' : '',
    impacted > 0 ? 'is-impacted' : '',
    inFlow ? 'is-in-flow' : '',
  ].join(' ');

  return (
    <div className={classes} title={node.path ?? node.name}>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} />
      <div className="xnode-header">
        {visible.childCount > 0 && (
          <button
            className="xnode-toggle"
            aria-label={visible.isContainer ? 'Collapse' : 'Expand'}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(visible.id);
            }}
          >
            {visible.isContainer ? '−' : '+'}
          </button>
        )}
        <span className="xnode-kind">{node.layer === 'symbol' ? node.type : LAYER_LABEL[node.layer]}</span>
        <span className="xnode-name">{node.name}</span>
        {flowEnd && <span className="xnode-badge flow">{flowEnd}</span>}
        {changed > 0 && (
          <span className="xnode-badge changed" title={`${changed} changed`}>
            {visible.isContainer || visible.childCount === 0 ? 'Δ' : `Δ ${changed}`}
          </span>
        )}
        {impacted > 0 && (
          <span className="xnode-badge impacted" title={`${impacted} affected by the change`}>
            {visible.isContainer || visible.childCount === 0 ? '!' : `! ${impacted}`}
          </span>
        )}
        {!visible.isContainer && visible.childCount > 0 && <span className="xnode-count">{visible.childCount}</span>}
      </div>
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />
    </div>
  );
});

const nodeTypes = { xnode: XNode };

const EDGE_COLORS: Record<string, string> = { imports: 'var(--edge-imports)', calls: 'var(--edge-calls)' };

type EdgeEmphasis = 'selected' | 'flow' | 'impact' | null;

function edgeStyle(edge: VisibleEdge, emphasis: EdgeEmphasis) {
  // Mixed roll-ups keep the normal style; the evidence panel spells out the mix.
  const heuristic = edge.deterministicCount === 0;
  const base = heuristic ? 'var(--heuristic)' : (EDGE_COLORS[edge.relation] ?? 'var(--edge-other)');
  const color = emphasis === 'selected' ? 'var(--accent)' : emphasis === 'flow' ? 'var(--flow)' : emphasis === 'impact' ? 'var(--impact)' : base;
  return {
    stroke: color,
    strokeWidth: emphasis ? 2.5 : Math.min(1 + Math.log2(edge.edgeIds.length), 3.5),
    strokeDasharray: heuristic ? '6 4' : edge.relation === 'imports' ? '2 3' : undefined,
    opacity: emphasis ? 1 : 0.75,
  };
}

interface Props {
  view: GraphView;
  highlights: Highlights;
  onSelectNode: (id: string) => void;
  onSelectEdge: (edge: VisibleEdge) => void;
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Zoom to these nodes instead of the whole graph; `seq` changes on every request. */
  focus: { ids: string[]; seq: number } | null;
}

export function GraphCanvas({ view, highlights, onSelectNode, onSelectEdge, onToggle, onClear, focus }: Props) {
  const boxes = useMemo(() => layoutView(view), [view]);
  const { fitView } = useReactFlow();

  const nodes = useMemo<Node<XNodeData>[]>(
    () =>
      view.nodes.map((visible) => {
        const box = boxes.get(visible.id)!;
        return {
          id: visible.id,
          type: 'xnode',
          position: { x: box.x, y: box.y },
          ...(visible.parent ? { parentId: visible.parent } : {}),
          style: { width: box.width, height: box.height },
          selected: highlights.selectedNode === visible.id,
          draggable: false,
          data: {
            visible,
            changed: highlights.changed.get(visible.id) ?? 0,
            impacted: highlights.impacted.get(visible.id) ?? 0,
            inFlow: highlights.flowNodes.has(visible.id),
            flowEnd:
              highlights.flowEnds.from === visible.id
                ? 'from'
                : highlights.flowEnds.to === visible.id
                  ? 'to'
                  : highlights.flowEnds.entries.has(visible.id)
                    ? 'entry'
                    : null,
            direction: box.direction,
            onToggle,
          },
        };
      }),
    [view, boxes, highlights, onToggle],
  );

  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((edge) => {
        const emphasis: EdgeEmphasis =
          highlights.selectedEdge === edge.id
            ? 'selected'
            : edge.edgeIds.some((id) => highlights.flowEdges.has(id))
              ? 'flow'
              : edge.edgeIds.some((id) => highlights.impactEdges.has(id))
                ? 'impact'
                : null;
        const style = edgeStyle(edge, emphasis);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          style,
          zIndex: emphasis ? 10 : 1,
          markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
          label: edge.edgeIds.length > 1 ? String(edge.edgeIds.length) : undefined,
          labelStyle: { fill: 'var(--muted)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--bg)' },
          interactionWidth: 14,
          data: { edge },
        };
      }),
    [view, highlights],
  );

  // Re-frame after React Flow has measured the new nodes: on a new focus
  // request zoom to that node, otherwise (expand, collapse) show everything.
  const lastFocus = useRef<number | null>(null);
  useEffect(() => {
    const isNew = focus !== null && focus.seq !== lastFocus.current;
    lastFocus.current = focus?.seq ?? null;
    const targets = isNew ? [...new Set(focus.ids.map((id) => view.representative(id)).filter((id) => id !== undefined))] : [];
    const timer = setTimeout(() => {
      void (targets.length > 0
        ? fitView({ nodes: targets.map((id) => ({ id })), padding: targets.length === 1 ? 1.2 : 0.25, duration: 300, maxZoom: 1.1 })
        : fitView({ padding: 0.12, duration: 250, maxZoom: 1.4 }));
    }, 60);
    return () => clearTimeout(timer);
  }, [view, focus, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => onSelectNode(node.id)}
      onNodeDoubleClick={(_event, node) => onToggle(node.id)}
      onEdgeClick={(_event, edge) => onSelectEdge((edge.data as { edge: VisibleEdge }).edge)}
      onPaneClick={onClear}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.01}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background gap={24} color="var(--grid)" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable style={{ width: 160, height: 110 }} nodeColor={(node) => (node.data as XNodeData).changed ? 'var(--changed)' : (node.data as XNodeData).impacted ? 'var(--impact)' : 'var(--minimap-node)'} />
    </ReactFlow>
  );
}
