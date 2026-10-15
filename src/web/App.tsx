import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffResponse, FlowResponse, GraphResponse, ImpactResponse } from '../shared/api-types.ts';
import { api } from './api.ts';
import { EvidencePanel, type Selection } from './EvidencePanel.tsx';
import { GraphCanvas, type Highlights } from './GraphCanvas.tsx';
import { ancestors, buildView, indexGraph, markVisible, searchNodes, type GraphIndex, type VisibleEdge } from './model.ts';

interface FlowState {
  from: string | null;
  to: string | null;
  /** Set when tracing a feature by question instead of between two nodes. */
  question: string | null;
  result: FlowResponse | null;
  error: string | null;
  loading: boolean;
}

interface ImpactState {
  seed: string;
  result: ImpactResponse | null;
  error: string | null;
}

const NO_FLOW: FlowState = { from: null, to: null, question: null, result: null, error: null, loading: false };

/** Reveal a traced flow node by node only while it stays readable. */
const MAX_REVEAL = 60;

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
  const [showDiffImpact, setShowDiffImpact] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [flow, setFlow] = useState<FlowState>(NO_FLOW);
  const [impact, setImpact] = useState<ImpactState | null>(null);

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

  const traceQuestion = (question: string) => {
    setFlow({ ...NO_FLOW, question, loading: true });
    api.flow({ question }).then(
      (result) => {
        setFlow((current) => (current.question === question ? { ...current, result, loading: false } : current));
        const reached = result.reachable?.nodes ?? [];
        const shown = reached.length <= MAX_REVEAL ? reached : (result.question?.entryPoints ?? []);
        reveal(shown);
        if (shown.length > 0) focusOn(shown);
      },
      (error: Error) =>
        setFlow((current) => (current.question === question ? { ...current, error: error.message, loading: false } : current)),
    );
  };

  const showImpact = (seed: string) => {
    setImpact({ seed, result: null, error: null });
    api.impact({ ids: [seed] }).then(
      (result) => setImpact((current) => (current?.seed === seed ? { ...current, result } : current)),
      (error: Error) => setImpact((current) => (current?.seed === seed ? { ...current, error: error.message } : current)),
    );
  };

  const changedIds = useMemo(() => new Set(diff?.nodeIds ?? []), [diff]);
  const changedFiles = useMemo(() => new Map((diff?.files ?? []).map((file) => [file.path, file])), [diff]);

  // An explicit blast radius wins over the diff's.
  const activeImpact = impact?.result ?? (showDiff && showDiffImpact ? (diff?.impact ?? null) : null);

  const highlights = useMemo<Highlights>(() => {
    const flowNodeIds = flow.result ? (flow.result.reachable?.nodes ?? flow.result.paths.flatMap((path) => path.nodes)) : [];
    const flowEdgeIds = flow.result ? (flow.result.reachable?.edges ?? flow.result.paths.flatMap((path) => path.edges)) : [];
    const entryPoints = flow.result?.question?.entryPoints ?? [];
    return {
      selectedNode: selection?.kind === 'node' ? (view.representative(selection.id) ?? null) : null,
      selectedEdge: selection?.kind === 'edge' ? selection.edge.id : null,
      changed: showDiff ? markVisible(view, changedIds) : new Map(),
      impacted: activeImpact ? markVisible(view, activeImpact.nodes.map((node) => node.id)) : new Map(),
      impactEdges: new Set(activeImpact?.edges ?? []),
      flowNodes: markVisible(view, flowNodeIds),
      flowEdges: new Set(flowEdgeIds),
      flowEnds: {
        from: flow.from ? (view.representative(flow.from) ?? null) : null,
        to: flow.to ? (view.representative(flow.to) ?? null) : null,
        entries: new Set(entryPoints.map((id) => view.representative(id)).filter((id) => id !== undefined)),
      },
    };
  }, [view, selection, showDiff, changedIds, activeImpact, flow]);

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

  const diffImpactFiles = diff?.impact.files.length ?? 0;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="logo" aria-hidden>◎</span>
          <span className="brand-name">Codebase X-Ray</span>
          <span className="repo" title={graph.root}>{basename(graph.root)}</span>
        </div>
        <SearchBox index={index} onSelect={selectNode} />
        <QuestionBox onAsk={traceQuestion} />
        <div className="toolbar-group">
          <label className="toggle">
            <input type="checkbox" checked={showExternal} onChange={(event) => setShowExternal(event.target.checked)} />
            External ({counts.externals})
          </label>
          <label className={`toggle ${diff?.isRepo ? '' : 'disabled'}`} title={diff?.isRepo ? 'Highlight uncommitted changes' : 'Not a git repository'}>
            <input type="checkbox" checked={showDiff} disabled={!diff?.isRepo} onChange={(event) => setShowDiff(event.target.checked)} />
            <i className="swatch-dot changed" />
            Diff{diff?.isRepo ? ` (${diff.files.length})` : ''}
          </label>
          {diff?.isRepo && (
            <label
              className={`toggle ${showDiff ? '' : 'disabled'}`}
              title="Highlight code that calls or imports the changed code, up to 3 hops away"
            >
              <input
                type="checkbox"
                checked={showDiffImpact}
                disabled={!showDiff}
                onChange={(event) => setShowDiffImpact(event.target.checked)}
              />
              <i className="swatch-dot impact" />
              Impact ({diffImpactFiles} {diffImpactFiles === 1 ? 'file' : 'files'})
            </label>
          )}
          <button onClick={() => setExpanded(new Set())} title="Collapse everything back to clusters">Collapse all</button>
        </div>
        <span className="stats">
          {counts.files} files · {counts.symbols} symbols · {counts.edges} edges
        </span>
      </header>

      {(flow.from || flow.to || flow.question) && (
        <FlowBar
          index={index}
          flow={flow}
          onSelect={selectNode}
          onDownstream={traceDownstream}
          onClear={() => setFlow(NO_FLOW)}
        />
      )}
      {impact && <ImpactBar index={index} impact={impact} onSelect={selectNode} onClear={() => setImpact(null)} />}

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
          onImpact={showImpact}
        />
      </main>
    </div>
  );
}

function FlowBar({ index, flow, onSelect, onDownstream, onClear }: { index: GraphIndex; flow: FlowState; onSelect: (id: string) => void; onDownstream: () => void; onClear: () => void }) {
  const name = (id: string | null) => (id ? (index.nodes.get(id)?.name ?? id) : null);
  const result = flow.result;

  if (flow.question !== null) {
    const entries = result?.question?.entryPoints ?? [];
    let status: string;
    if (flow.loading) status = 'Tracing…';
    else if (flow.error) status = flow.error;
    else if (entries.length === 0) status = `Nothing matches "${result?.question?.keywords.join(' ') ?? flow.question}"`;
    else status = `${result?.reachable?.nodes.length ?? 0} nodes traced from`;
    return (
      <div className="flowbar">
        <span className="flowbar-label">Feature</span>
        <span className="chip static">{flow.question}</span>
        <span className={`flowbar-status ${flow.error ? 'error' : ''}`}>{status}</span>
        {entries.map((id) => (
          <button key={id} className="link" onClick={() => onSelect(id)}>{name(id)}</button>
        ))}
        <button onClick={onClear}>Clear</button>
      </div>
    );
  }

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

function ImpactBar({ index, impact, onSelect, onClear }: { index: GraphIndex; impact: ImpactState; onSelect: (id: string) => void; onClear: () => void }) {
  const seed = index.nodes.get(impact.seed);
  const result = impact.result;
  let status: string;
  if (impact.error) status = impact.error;
  else if (!result) status = 'Tracing…';
  else if (result.nodes.length === 0) status = 'Nothing depends on it within 4 hops.';
  else {
    const { symbols, files, clusters } = result.summary;
    status = `${count(symbols, 'symbol')} in ${count(files, 'file')} across ${count(clusters, 'cluster')} depend on it:`;
  }
  return (
    <div className="flowbar impactbar">
      <span className="flowbar-label">Blast radius</span>
      <button className="chip" onClick={() => onSelect(impact.seed)}>{seed?.symbol ?? seed?.name ?? impact.seed}</button>
      <span className={`flowbar-status ${impact.error ? 'error' : ''}`}>{status}</span>
      {result?.files.slice(0, 6).map((file) => (
        <button key={file.path} className="link" onClick={() => onSelect(file.nodeIds[0]!)} title={`${file.depth} hop${file.depth > 1 ? 's' : ''} away`}>
          {basename(file.path)}
        </button>
      ))}
      {result && result.files.length > 6 && <span className="muted">+{result.files.length - 6} more</span>}
      <button onClick={onClear}>Clear</button>
    </div>
  );
}

function QuestionBox({ onAsk }: { onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState('');
  return (
    <form
      className="question"
      onSubmit={(event) => {
        event.preventDefault();
        if (question.trim()) onAsk(question.trim());
      }}
    >
      <input
        type="search"
        placeholder="Trace a feature: how does login work?"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
    </form>
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
      <span><i className="swatch impact" /> impact</span>
    </div>
  );
}

function count(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
