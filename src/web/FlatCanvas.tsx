import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, useEffect, useMemo } from 'react';
import { layoutFlat, type FlatNode, type FlatView } from './focus.ts';
import type { VisibleEdge } from './model.ts';

export interface FlatHighlights {
  selectedNode: string | null;
  selectedEdge: string | null;
  changed: ReadonlySet<string>;
  impacted: ReadonlySet<string>;
  /** Entry points of a traced feature, or the ends of a traced path. */
  entries: ReadonlySet<string>;
}

interface CardData extends Record<string, unknown> {
  flat: FlatNode;
  changed: boolean;
  impacted: boolean;
  entry: boolean;
}

const KIND: Record<string, string> = { cluster: 'cluster', file: 'file', external: 'package' };

const Card = memo(function Card({ data, selected }: NodeProps<Node<CardData>>) {
  const { flat, changed, impacted, entry } = data;
  const { node } = flat;
  const kind = node.layer === 'symbol' ? node.type : (KIND[node.layer] ?? node.layer);
  const where =
    node.layer === 'symbol'
      ? `${node.path}:${node.startLine}`
      : node.layer === 'file'
        ? node.path
        : node.layer === 'external'
          ? node.type === 'builtin' ? 'node builtin' : 'npm package'
          : 'folder';
  const classes = [
    'card',
    `layer-${node.layer}`,
    `role-${flat.role}`,
    selected ? 'is-selected' : '',
    changed ? 'is-changed' : '',
    impacted ? 'is-impacted' : '',
  ].join(' ');
  return (
    <div className={classes}>
      <Handle type="target" position={Position.Left} />
      <div className="card-top">
        <span className="card-kind">{kind}</span>
        {entry && <span className="card-badge entry">start</span>}
        {changed && <span className="card-badge changed">changed</span>}
        {impacted && <span className="card-badge impacted">at risk</span>}
        {flat.members > 1 && <span className="card-badge count">{flat.members}</span>}
      </div>
      <div className="card-name" title={node.symbol ?? node.name}>{node.symbol ?? node.name}</div>
      <div className="card-where" title={where ?? ''}>{where}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { card: Card };

interface Props {
  view: FlatView;
  highlights: FlatHighlights;
  onNodeClick: (id: string) => void;
  onEdgeClick: (edge: VisibleEdge) => void;
  emptyText: string;
}

export function FlatCanvas({ view, highlights, onNodeClick, onEdgeClick, emptyText }: Props) {
  const boxes = useMemo(() => layoutFlat(view), [view]);
  const { fitView } = useReactFlow();

  const nodes = useMemo<Node<CardData>[]>(
    () =>
      view.nodes.map((flat) => {
        const box = boxes.get(flat.id)!;
        return {
          id: flat.id,
          type: 'card',
          position: { x: box.x, y: box.y },
          style: { width: box.width, height: box.height },
          selected: highlights.selectedNode === flat.id,
          draggable: false,
          data: {
            flat,
            changed: highlights.changed.has(flat.id),
            impacted: highlights.impacted.has(flat.id),
            entry: highlights.entries.has(flat.id),
          },
        };
      }),
    [view, boxes, highlights],
  );

  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((edge) => {
        const selected = highlights.selectedEdge === edge.id;
        const uncertain = edge.deterministicCount === 0;
        const towardsSelection = highlights.selectedNode !== null && (edge.source === highlights.selectedNode || edge.target === highlights.selectedNode);
        const color = selected ? 'var(--accent)' : uncertain ? 'var(--heuristic)' : edge.relation === 'imports' ? 'var(--edge-imports)' : 'var(--edge-calls)';
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          style: {
            stroke: color,
            strokeWidth: selected || towardsSelection ? 2.4 : 1.6,
            strokeDasharray: uncertain ? '6 4' : edge.relation === 'imports' ? '3 3' : undefined,
            opacity: highlights.selectedNode === null || towardsSelection || selected ? 1 : 0.35,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          label: edge.edgeIds.length > 1 ? `${edge.edgeIds.length}×` : undefined,
          labelStyle: { fill: 'var(--muted)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--bg)' },
          interactionWidth: 16,
          data: { edge },
        };
      }),
    [view, highlights],
  );

  useEffect(() => {
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 250, maxZoom: 1.1 }), 60);
    return () => clearTimeout(timer);
  }, [view, fitView]);

  if (view.nodes.length === 0) return <div className="canvas-empty">{emptyText}</div>;

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => onNodeClick(node.id)}
      onEdgeClick={(_event, edge) => onEdgeClick((edge.data as { edge: VisibleEdge }).edge)}
      nodesConnectable={false}
      minZoom={0.05}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background gap={24} color="var(--grid)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
