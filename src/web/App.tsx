import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffResponse, FlowResponse, GraphResponse } from '../shared/api-types.ts';
import { api } from './api.ts';
import { EvidencePanel, type Selection } from './EvidencePanel.tsx';
import { GraphCanvas, type Highlights } from './GraphCanvas.tsx';
import { ancestors, buildView, indexGraph, markVisible, searchNodes, type GraphIndex, type VisibleEdge } from './model.ts';

interface FlowState {
  from: string | null;
  to: string | null;
  result: FlowResponse | null;
  error: string | null;
  loading: boolean;
}

const NO_FLOW: FlowState = { from: null, to: null, result: null, error: null, loading: false };

export function App() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);

  useEffect(() => {
    api.graph().then(setGraph, (error: Error) => setLoadError(error.message));
    api.diff().then(setDiff, () => setDiff(null));
  }, []);

  if (loadError) return <div className="splash error">Could not load the graph: {loadError}</div>;
  if (!graph) return <div className="splash">Loading evidence graph…</div>;
  if (graph.nodes.length === 0) {
    return <div className="splash">The index is empty. Run <code>xray index &lt;path&gt;</code> first.</div>;
  }
  return (
    <ReactFlowProvider>
      <Explorer graph={graph} diff={diff} />
    </ReactFlowProvider>
  );
}

function Explorer({ graph, diff }: { graph: GraphResponse; diff: DiffResponse | null }) {
  const index = useMemo(() => indexGraph(graph), [graph]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showExternal, setShowExternal] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [flow, setFlow] = useState<FlowState>(NO_FLOW);

  const view = useMemo(() => buildView(index, { expanded, showExternal }), [index, expanded, showExternal]);

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Expands every ancestor so the given nodes are drawn individually. */
  const reveal = useCallback(
    (ids: string[]) => {
      const toExpand = ids.flatMap((id) => ancestors(index, id));
      if (ids.some((id) => index.nodes.get(id)?.layer === 'external')) setShowExternal(true);
      setExpanded((previous) => (toExpand.every((id) => previous.has(id)) ? previous : new Set([...previous, ...toExpand])));
    },
    [index],
  );

  const [focus, setFocus] = useState<{ ids: string[]; seq: number } | null>(null);
  const focusOn = useCallback((ids: string[]) => setFocus((previous) => ({ ids, seq: (previous?.seq ?? 0) + 1 })), []);

  /** Select from the canvas: the node is already on screen. */
  const pickNode = useCallback((id: string) => setSelection({ kind: 'node', id }), []);
  /** Select from search or the panel: reveal the node and zoom to it. */
  const selectNode = useCallback(
    (id: string) => {
      reveal([id]);
      setSelection({ kind: 'node', id });
      focusOn([id]);
    },
    [reveal, focusOn],
  );
  const selectEdge = useCallback((edge: VisibleEdge) => setSelection({ kind: 'edge', edge }), []);
  const clearSelection = useCallback(() => setSelection(null), []);

  // Trace as soon as both ends are picked.
  useEffect(() => {
    if (!flow.from || !flow.to || flow.result || flow.error || flow.loading) return;
    const { from, to } = flow;
    // Ignore the answer if the user picked different ends meanwhile.
    const update = (patch: Partial<FlowState>) =>
      setFlow((current) => (current.from === from && current.to === to ? { ...current, ...patch, loading: false } : current));
    setFlow((current) => ({ ...current, loading: true }));
    api.flow({ from, to }).then(
      (result) => {
        update({ result });
        const nodes = result.paths.flatMap((path) => path.nodes);
        reveal(nodes);
        if (nodes.length > 0) focusOn(nodes);
      },
      (error: Error) => update({ error: error.message }),
    );
  }, [flow, reveal, focusOn]);

  const traceDownstream = () => {
    if (!flow.from) return;
    setFlow((current) => ({ ...current, to: null, loading: true, result: null, error: null }));
    api.flow({ from: flow.from }).then(
      (result) => setFlow((current) => ({ ...current, result, loading: false })),
      (error: Error) => setFlow((current) => ({ ...current, error: error.message, loading: false })),
    );
  };

  const changedIds = useMemo(() => new Set(diff?.nodeIds ?? []), [diff]);
  const changedFiles = useMemo(() => new Map((diff?.files ?? []).map((file) => [file.path, file])), [diff]);

  const highlights = useMemo<Highlights>(() => {
    const flowNodeIds = flow.result ? (flow.result.reachable?.nodes ?? flow.result.paths.flatMap((path) => path.nodes)) : [];
    const flowEdgeIds = flow.result ? (flow.result.reachable?.edges ?? flow.result.paths.flatMap((path) => path.edges)) : [];
    return {
      selectedNode: selection?.kind === 'node' ? (view.representative(selection.id) ?? null) : null,
      selectedEdge: selection?.kind === 'edge' ? selection.edge.id : null,
      changed: showDiff ? markVisible(view, changedIds) : new Map(),
      flowNodes: markVisible(view, flowNodeIds),
      flowEdges: new Set(flowEdgeIds),
      flowEnds: {
        from: flow.from ? (view.representative(flow.from) ?? null) : null,
        to: flow.to ? (view.representative(flow.to) ?? null) : null,
      },
    };
  }, [view, selection, showDiff, changedIds, flow]);

  // A selected edge may no longer exist after expanding or collapsing.
  useEffect(() => {
    if (selection?.kind === 'edge' && !view.edges.some((edge) => edge.id === selection.edge.id)) setSelection(null);
  }, [view, selection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const counts = useMemo(() => {
    const byLayer = (layer: string) => graph.nodes.filter((node) => node.layer === layer).length;
    return { files: byLayer('file'), symbols: byLayer('symbol'), externals: byLayer('external'), edges: graph.edges.length };
  }, [graph]);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden>◎</span>
          <span className="brand-name">Codebase X-Ray</span>
          <span className="repo" title={graph.root}>{basename(graph.root)}</span>
        </div>
        <SearchBox index={index} onSelect={selectNode} />
        <div className="toolbar-group">
          <label className="toggle">
            <input type="checkbox" checked={showExternal} onChange={(event) => setShowExternal(event.target.checked)} />
            External ({counts.externals})
          </label>
          <label className={`toggle ${diff?.isRepo ? '' : 'disabled'}`} title={diff?.isRepo ? 'Highlight uncommitted changes' : 'Not a git repository'}>
            <input type="checkbox" checked={showDiff} disabled={!diff?.isRepo} onChange={(event) => setShowDiff(event.target.checked)} />
            Diff{diff?.isRepo ? ` (${diff.files.length} changed)` : ''}
          </label>
          <button onClick={() => setExpanded(new Set())} title="Collapse everything back to clusters">Collapse all</button>
        </div>
        <span className="stats">
          {counts.files} files · {counts.symbols} symbols · {counts.edges} edges
        </span>
      </header>

      {(flow.from || flow.to) && (
        <FlowBar
          index={index}
          flow={flow}
          onSelect={selectNode}
          onDownstream={traceDownstream}
          onClear={() => setFlow(NO_FLOW)}
        />
      )}

      <main className="workspace">
        <div className="canvas">
          <GraphCanvas
            view={view}
            highlights={highlights}
            onSelectNode={pickNode}
            onSelectEdge={selectEdge}
            focus={focus}
            onToggle={toggle}
            onClear={clearSelection}
          />
          <Legend />
        </div>
        <EvidencePanel
          index={index}
          selection={selection}
          expanded={expanded}
          changedFiles={changedFiles}
          changedIds={changedIds}
          onSelectNode={selectNode}
          onToggle={toggle}
          onTraceFrom={(id) => setFlow((current) => ({ ...NO_FLOW, from: id, to: current.to === id ? null : current.to }))}
          onTraceTo={(id) => setFlow((current) => ({ ...NO_FLOW, to: id, from: current.from === id ? null : current.from }))}
        />
      </main>
    </div>
  );
}

function FlowBar({ index, flow, onSelect, onDownstream, onClear }: { index: GraphIndex; flow: FlowState; onSelect: (id: string) => void; onDownstream: () => void; onClear: () => void }) {
  const name = (id: string | null) => (id ? (index.nodes.get(id)?.name ?? id) : null);
  const result = flow.result;
  let status: string;
  if (flow.loading) status = 'Tracing…';
  else if (flow.error) status = flow.error;
  else if (result?.reachable) status = `${result.reachable.nodes.length} nodes reachable downstream`;
  else if (result) status = result.paths.length === 0 ? 'No path found within 8 hops' : `${result.paths.length} shortest path${result.paths.length > 1 ? 's' : ''}, ${result.paths[0]!.edges.length} hops`;
  else status = flow.from ? 'Pick a target with "Trace to here", or show everything downstream.' : 'Pick a start with "Trace from here".';

  return (
    <div className="flowbar">
      <span className="flowbar-label">Flow</span>
      <button className="chip" disabled={!flow.from} onClick={() => flow.from && onSelect(flow.from)}>{name(flow.from) ?? 'start?'}</button>
      <span className="arrow">→</span>
      <button className="chip" disabled={!flow.to} onClick={() => flow.to && onSelect(flow.to)}>{name(flow.to) ?? 'target?'}</button>
      <span className={`flowbar-status ${flow.error ? 'error' : ''}`}>{status}</span>
      {result && result.paths.length > 0 && (
        <span className="flowbar-path">
          {result.paths[0]!.nodes.map((id, i) => (
            <span key={id}>
              {i > 0 && <span className="arrow">→</span>}
              <button className="link" onClick={() => onSelect(id)}>{name(id)}</button>
            </span>
          ))}
        </span>
      )}
      {flow.from && !flow.to && !flow.loading && <button onClick={onDownstream}>Show downstream</button>}
      <button onClick={onClear}>Clear</button>
    </div>
  );
}

function SearchBox({ index, onSelect }: { index: GraphIndex; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchNodes(index, query), [index, query]);
  const choose = (id: string) => {
    onSelect(id);
    setQuery('');
  };
  return (
    <div className="search">
      <input
        type="search"
        placeholder="Search files and symbols…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') setActive((i) => Math.min(i + 1, results.length - 1));
          else if (event.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
          else if (event.key === 'Enter' && results[active]) choose(results[active].id);
          else if (event.key === 'Escape') setQuery('');
        }}
      />
      {results.length > 0 && (
        <ul className="search-results">
          {results.map((node, i) => (
            <li key={node.id} className={i === active ? 'active' : ''} onMouseDown={() => choose(node.id)}>
              <span className={`dot layer-${node.layer}`} />
              <span className="search-name">{node.symbol ?? node.name}</span>
              <span className="muted small">{node.layer === 'symbol' ? `${node.type} · ${node.path}` : (node.path ?? node.layer)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i className="swatch calls" /> calls</span>
      <span><i className="swatch imports" /> imports</span>
      <span><i className="swatch heuristic" /> heuristic</span>
      <span><i className="swatch flow" /> flow</span>
      <span><i className="swatch changed" /> changed</span>
    </div>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
