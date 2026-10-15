import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiStatus, DiffResponse, GraphResponse } from '../shared/api-types.ts';
import { api } from './api.ts';
import type { AnswerState } from './AnswerView.tsx';
import { EvidencePanel, type Selection } from './EvidencePanel.tsx';
import { FlatCanvas, type FlatHighlights } from './FlatCanvas.tsx';
import { focusView, subgraphView } from './focus.ts';
import { GraphCanvas, type Highlights } from './GraphCanvas.tsx';
import { ancestors, buildView, indexGraph, markVisible, searchNodes, type GraphIndex, type VisibleEdge } from './model.ts';

type Mode = 'map' | 'focus' | 'trace';

/** The result shown in Trace mode. */
interface Trace {
  kind: 'path' | 'downstream' | 'feature' | 'impact' | 'diff';
  title: string;
  status: string;
  nodeIds: string[];
  edgeIds: number[];
  /** Where it starts: entry points, path ends, or the node a blast radius is for. */
  entries: string[];
  changed: string[];
  impacted: string[];
}

const EMPTY_TRACE_SETS = { changed: [], impacted: [] };

export function App() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);

  useEffect(() => {
    api.graph().then(setGraph, (error: Error) => setLoadError(error.message));
    api.diff().then(setDiff, () => setDiff(null));
    api.ai().then(setAi, () => setAi(null));
  }, []);

  if (loadError) return <div className="splash error">Could not load the graph: {loadError}</div>;
  if (!graph) return <div className="splash">Loading evidence graph…</div>;
  if (graph.nodes.length === 0) {
    return <div className="splash">The index is empty. Run <code>xray index &lt;path&gt;</code> first.</div>;
  }
  return (
    <>
      <Explorer graph={graph} diff={diff} ai={ai} />
    </>
  );
}

function Explorer({ graph, diff, ai }: { graph: GraphResponse; diff: DiffResponse | null; ai: AiStatus | null }) {
  const index = useMemo(() => indexGraph(graph), [graph]);
  const [mode, setMode] = useState<Mode>('map');
  const [selection, setSelection] = useState<Selection>(null);

  // Map
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showExternal, setShowExternal] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [mapFocus, setMapFocus] = useState<{ ids: string[]; seq: number } | null>(null);
  const mapView = useMemo(() => buildView(index, { expanded, showExternal }), [index, expanded, showExternal]);

  // Focus
  const [focusHistory, setFocusHistory] = useState<string[]>([]);
  const [focusDepth, setFocusDepth] = useState(1);
  const [focusImports, setFocusImports] = useState(true);
  const focusId = focusHistory.at(-1) ?? null;
  const focused = useMemo(
    () => (focusId ? focusView(index, focusId, { depth: focusDepth, relations: focusImports ? ['calls', 'imports'] : ['calls'] }) : null),
    [index, focusId, focusDepth, focusImports],
  );

  // Trace
  const [trace, setTrace] = useState<Trace | null>(null);
  const [tracing, setTracing] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [pathPick, setPathPick] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const traced = useMemo(() => (trace ? subgraphView(index, trace.nodeIds, trace.edgeIds) : null), [index, trace]);

  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const aiLabel = ai?.provider ? `${ai.provider.name} (${ai.provider.model})` : null;

  /** Explain a question with AI, grounded in its trace; without a provider the server returns the trace and how to set one up. */
  const explain = (question: string) => {
    setAnswer({ question, loading: true, error: null, response: null });
    setSelection({ kind: 'answer' });
    api.ask({ question }).then(
      (response) => setAnswer((current) => (current?.question === question ? { ...current, loading: false, response } : current)),
      (error: Error) => setAnswer((current) => (current?.question === question ? { ...current, loading: false, error: error.message } : current)),
    );
  };

  const selectEdgeId = (id: number) => {
    const edge = index.edgesById.get(id);
    if (!edge) return;
    setSelection({
      kind: 'edge',
      edge: {
        id: `edge-${id}`,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        relations: [edge.relation],
        edgeIds: [id],
        resolutionType: edge.resolutionType,
        confidence: edge.confidence,
        deterministicCount: edge.resolutionType === 'deterministic' ? 1 : 0,
      },
    });
  };

  const name = useCallback((id: string) => index.nodes.get(id)?.symbol ?? index.nodes.get(id)?.name ?? id, [index]);

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const focusOn = useCallback((id: string) => {
    setFocusHistory((history) => (history.at(-1) === id ? history : [...history, id].slice(-50)));
    setSelection({ kind: 'node', id });
    setMode('focus');
  }, []);

  const showInMap = useCallback(
    (id: string) => {
      const toExpand = ancestors(index, id);
      if (index.nodes.get(id)?.layer === 'external') setShowExternal(true);
      setExpanded((previous) => new Set([...previous, ...toExpand]));
      setSelection({ kind: 'node', id });
      setMapFocus((previous) => ({ ids: [id], seq: (previous?.seq ?? 0) + 1 }));
      setMode('map');
    },
    [index],
  );

  const run = (label: string, work: () => Promise<Trace>) => {
    setTracing(label);
    setTraceError(null);
    work().then(
      (result) => {
        setTrace(result);
        setSelection(null);
        setMode('trace');
        setTracing(null);
      },
      (error: Error) => {
        setTraceError(error.message);
        setTracing(null);
      },
    );
  };

  const traceQuestion = (question: string) =>
    run(question, async () => {
      const result = await api.flow({ question });
      const entries = result.question?.entryPoints ?? [];
      return {
        kind: 'feature',
        title: question,
        status: entries.length === 0 ? 'Nothing in the code matches those words.' : `${result.reachable?.nodes.length ?? 0} nodes, starting from`,
        nodeIds: result.reachable?.nodes ?? [],
        edgeIds: result.reachable?.edges ?? [],
        entries,
        ...EMPTY_TRACE_SETS,
      };
    });

  const tracePath = (from: string, to: string) =>
    run(`${name(from)} → ${name(to)}`, async () => {
      const result = await api.flow({ from, to });
      return {
        kind: 'path',
        title: `${name(from)} → ${name(to)}`,
        status: result.paths.length === 0 ? 'No path within 8 hops.' : `${result.paths.length} shortest path${result.paths.length > 1 ? 's' : ''}, ${result.paths[0]!.edges.length} hops`,
        nodeIds: [...new Set(result.paths.flatMap((path) => path.nodes))],
        edgeIds: [...new Set(result.paths.flatMap((path) => path.edges))],
        entries: [from, to],
        ...EMPTY_TRACE_SETS,
      };
    });

  const traceDownstream = (from: string) =>
    run(`everything ${name(from)} reaches`, async () => {
      const result = await api.flow({ from });
      return {
        kind: 'downstream',
        title: `downstream of ${name(from)}`,
        status: `${result.reachable?.nodes.length ?? 0} nodes reachable`,
        nodeIds: result.reachable?.nodes ?? [],
        edgeIds: result.reachable?.edges ?? [],
        entries: [from],
        ...EMPTY_TRACE_SETS,
      };
    });

  const traceImpact = (id: string) =>
    run(`blast radius of ${name(id)}`, async () => {
      const result = await api.impact({ ids: [id] });
      const { symbols, files, clusters } = result.summary;
      return {
        kind: 'impact',
        title: `blast radius of ${name(id)}`,
        status: result.nodes.length === 0 ? 'Nothing depends on it within 4 hops.' : `${count(symbols, 'symbol')} in ${count(files, 'file')} across ${count(clusters, 'cluster')} depend on it`,
        nodeIds: [id, ...result.nodes.map((node) => node.id)],
        edgeIds: result.edges,
        entries: [id],
        changed: [],
        impacted: result.nodes.map((node) => node.id),
      };
    });

  const reviewChanges = () => {
    if (!diff) return;
    // Show changed symbols; a file only when the change is not inside any of its symbols.
    const changed = diff.files.flatMap((file) => (file.symbolIds.length > 0 ? file.symbolIds : file.nodeId ? [file.nodeId] : []));
    const impacted = diff.impact.nodes.map((node) => node.id);
    const { symbols, files } = diff.impact.summary;
    setTrace({
      kind: 'diff',
      title: `${count(diff.files.length, 'changed file')}`,
      status: impacted.length === 0 ? 'Nothing else calls or imports the changed code.' : `${count(symbols, 'symbol')} in ${count(files, 'file')} call or import the changed code`,
      nodeIds: [...diff.impact.seeds, ...changed, ...impacted],
      edgeIds: diff.impact.edges,
      entries: [],
      changed: diff.nodeIds,
      impacted,
    });
    setSelection(null);
    setMode('trace');
  };

  // Path tracing: pick both ends, then trace.
  useEffect(() => {
    if (pathPick.from && pathPick.to) {
      tracePath(pathPick.from, pathPick.to);
      setPathPick({ from: null, to: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathPick]);

  const changedIds = useMemo(() => new Set(diff?.nodeIds ?? []), [diff]);
  const changedFiles = useMemo(() => new Map((diff?.files ?? []).map((file) => [file.path, file])), [diff]);
  const diffImpacted = useMemo(() => new Set(diff?.impact.nodes.map((node) => node.id) ?? []), [diff]);

  const mapHighlights = useMemo<Highlights>(() => {
    const flowLike = trace && trace.kind !== 'impact' && trace.kind !== 'diff';
    return {
      selectedNode: selection?.kind === 'node' ? (mapView.representative(selection.id) ?? null) : null,
      selectedEdge: selection?.kind === 'edge' ? selection.edge.id : null,
      changed: showDiff ? markVisible(mapView, changedIds) : new Map(),
      impacted: showDiff ? markVisible(mapView, diffImpacted) : new Map(),
      impactEdges: new Set(showDiff ? (diff?.impact.edges ?? []) : []),
      flowNodes: flowLike ? markVisible(mapView, trace.nodeIds) : new Map(),
      flowEdges: new Set(flowLike ? trace.edgeIds : []),
      flowEnds: { from: null, to: null, entries: new Set() },
    };
  }, [mapView, selection, showDiff, changedIds, diffImpacted, diff, trace]);

  const flatHighlights = (view: { representative: (id: string) => string | undefined }, extra?: Trace): FlatHighlights => {
    const mark = (ids: Iterable<string>) => new Set([...ids].map((id) => view.representative(id)).filter((id): id is string => id !== undefined));
    return {
      selectedNode: selection?.kind === 'node' ? (view.representative(selection.id) ?? null) : null,
      selectedEdge: selection?.kind === 'edge' ? selection.edge.id : null,
      changed: mark(extra ? extra.changed : showDiff ? changedIds : []),
      impacted: mark(extra ? extra.impacted : showDiff ? diffImpacted : []),
      entries: mark(extra?.entries ?? []),
    };
  };

  const selectEdge = useCallback((edge: VisibleEdge) => setSelection({ kind: 'edge', edge }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') setSelection(null);
      if (event.key === 'Backspace' && mode === 'focus' && focusHistory.length > 1) setFocusHistory((h) => h.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, focusHistory.length]);

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
        <SearchBox index={index} onSelect={focusOn} />
        <QuestionBox onAsk={traceQuestion} />
        {diff?.isRepo && (
          <button
            className={diff.files.length > 0 ? 'review' : ''}
            disabled={diff.files.length === 0}
            onClick={reviewChanges}
            title="Your uncommitted changes and everything that calls or imports them"
          >
            Review changes{diff.files.length > 0 ? ` (${diff.files.length})` : ''}
          </button>
        )}
        <span className="stats">
          {counts.files} files · {counts.symbols} symbols · {counts.edges} edges
        </span>
      </header>

      <nav className="modebar">
        <div className="tabs" role="tablist">
          <button role="tab" className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}>Map</button>
          <button
            role="tab"
            className={mode === 'focus' ? 'active' : ''}
            onClick={() => (selection?.kind === 'node' && selection.id !== focusId ? focusOn(selection.id) : setMode('focus'))}
            title="One function, class or file with what calls it and what it calls"
          >
            Focus{focusId ? `: ${name(focusId)}` : ''}
          </button>
          <button role="tab" className={mode === 'trace' ? 'active' : ''} onClick={() => setMode('trace')} title="Feature traces, paths, blast radius and change reviews">
            Trace{trace ? `: ${trace.title}` : ''}
          </button>
        </div>
        <div className="modebar-tools">
          {tracing && <span className="muted">Tracing {tracing}…</span>}
          {answer && selection?.kind !== 'answer' && (
            <button className="link" onClick={() => setSelection({ kind: 'answer' })}>Back to the AI answer</button>
          )}
          {traceError && <span className="error-text">{traceError}</span>}
          {(pathPick.from || pathPick.to) && (
            <span className="pick">
              Path from <strong>{pathPick.from ? name(pathPick.from) : '…'}</strong> to <strong>{pathPick.to ? name(pathPick.to) : '…'}</strong>
              {pathPick.from && !pathPick.to && <> · pick the end with <em>Path to</em>, or <button className="link" onClick={() => { traceDownstream(pathPick.from!); setPathPick({ from: null, to: null }); }}>show everything downstream</button></>}
              <button className="link" onClick={() => setPathPick({ from: null, to: null })}>cancel</button>
            </span>
          )}
          {mode === 'map' && (
            <>
              <label className="toggle">
                <input type="checkbox" checked={showExternal} onChange={(event) => setShowExternal(event.target.checked)} />
                Packages ({counts.externals})
              </label>
              {diff?.isRepo && (
                <label className="toggle" title="Changed code in amber, what depends on it in red">
                  <input type="checkbox" checked={showDiff} onChange={(event) => setShowDiff(event.target.checked)} />
                  Changes
                </label>
              )}
              <button onClick={() => setExpanded(new Set())}>Collapse all</button>
            </>
          )}
          {mode === 'focus' && focused && (
            <>
              <button disabled={focusHistory.length < 2} onClick={() => setFocusHistory((h) => h.slice(0, -1))} title="Back (Backspace)">← Back</button>
              <span className="muted">
                {focused.counts.upstream} {focused.counts.upstream === 1 ? 'caller' : 'callers'} · {focused.counts.downstream} {focused.counts.downstream === 1 ? 'dependency' : 'dependencies'}
              </span>
              <span className="segmented">
                Depth
                {[1, 2].map((depth) => (
                  <button key={depth} className={focusDepth === depth ? 'active' : ''} onClick={() => setFocusDepth(depth)}>{depth}</button>
                ))}
              </span>
              <label className="toggle">
                <input type="checkbox" checked={focusImports} onChange={(event) => setFocusImports(event.target.checked)} />
                Imports
              </label>
            </>
          )}
          {mode === 'trace' && trace && (
            <>
              {trace.kind === 'feature' && trace.entries.length > 0 && (
                <button
                  className="ai-button"
                  onClick={() => explain(trace.title)}
                  title={aiLabel ? `Explain this flow with ${aiLabel}, citing the traced evidence` : `No AI provider configured: set ${ai?.envVars.join(', ') ?? 'an API key'} to get a written explanation`}
                >
                  ✦ Explain with AI
                </button>
              )}
              <span className="trace-status">{trace.status}</span>
              {trace.entries.map((id) => (
                <button key={id} className="link" onClick={() => setSelection({ kind: 'node', id })}>{name(id)}</button>
              ))}
              <button onClick={() => { setTrace(null); setMode(focusId ? 'focus' : 'map'); }}>Close</button>
            </>
          )}
        </div>
      </nav>

      <main className="workspace">
        <div className="canvas">
          {mode === 'map' && (
            <>
              <GraphCanvas
                view={mapView}
                highlights={mapHighlights}
                onSelectNode={(id) => setSelection({ kind: 'node', id })}
                onOpenNode={focusOn}
                onSelectEdge={selectEdge}
                focus={mapFocus}
                onToggle={toggle}
                onClear={() => setSelection(null)}
              />
              <Legend />
            </>
          )}
          {mode === 'focus' && !focused && <FocusPicker index={index} onPick={focusOn} />}
          {mode === 'trace' && !trace && (
            <div className="canvas-start">
              <h2>Nothing traced yet</h2>
              <p>Ask a question in the <strong>Trace a feature</strong> box above, for example <em>how does login work?</em></p>
              <p>Or select something and use <strong>Blast radius</strong>, <strong>Path from</strong> / <strong>Path to</strong> in the panel on the right.</p>
              {diff?.isRepo && diff.files.length > 0 && (
                <p><button className="review" onClick={reviewChanges}>Review your {count(diff.files.length, 'changed file')}</button></p>
              )}
            </div>
          )}
          {mode === 'focus' && focused && (
            <FlatCanvas
              view={focused}
              highlights={flatHighlights(focused)}
              onNodeClick={(id) => (id === focusId ? setSelection({ kind: 'node', id }) : focusOn(id))}
              onEdgeClick={selectEdge}
              emptyText="Nothing to show."
            />
          )}
          {mode === 'trace' && traced && trace && (
            <FlatCanvas
              view={traced}
              highlights={flatHighlights(traced, trace)}
              onNodeClick={(id) => setSelection({ kind: 'node', id })}
              onEdgeClick={selectEdge}
              emptyText={trace.status}
            />
          )}
        </div>
        <EvidencePanel
          index={index}
          selection={selection}
          expanded={expanded}
          changedFiles={changedFiles}
          changedIds={changedIds}
          onSelectNode={(id) => (mode === 'focus' ? focusOn(id) : setSelection({ kind: 'node', id }))}
          onToggle={toggle}
          onTraceFrom={(id) => setPathPick((pick) => ({ ...pick, from: id }))}
          onTraceTo={(id) => setPathPick((pick) => ({ ...pick, to: id }))}
          onImpact={traceImpact}
          onFocus={focusOn}
          onShowInMap={showInMap}
          answer={answer}
          aiLabel={aiLabel}
          onSelectEdgeId={selectEdgeId}
        />
      </main>
    </div>
  );
}

/** Shown in Focus before anything is focused: the most connected code, as a place to start. */
function FocusPicker({ index, onPick }: { index: GraphIndex; onPick: (id: string) => void }) {
  const hubs = useMemo(() => {
    const degree = (id: string) => (index.incoming.get(id)?.length ?? 0) + (index.outgoing.get(id)?.length ?? 0);
    return [...index.nodes.values()]
      .filter((node) => node.layer === 'symbol' && node.type !== 'interface' && node.type !== 'type')
      .sort((a, b) => degree(b.id) - degree(a.id) || a.id.localeCompare(b.id))
      .slice(0, 12)
      .map((node) => ({ node, links: degree(node.id) }));
  }, [index]);
  return (
    <div className="canvas-start">
      <h2>Pick something to focus on</h2>
      <p>Search for a function, class or file above, double-click one on the map, or start with the most connected code:</p>
      <ul className="hub-list">
        {hubs.map(({ node, links }) => (
          <li key={node.id}>
            <button onClick={() => onPick(node.id)}>
              <span className="hub-name">{node.symbol ?? node.name}</span>
              <span className="muted small">{node.path} · {links} links</span>
            </button>
          </li>
        ))}
      </ul>
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
        placeholder="Search a function, class or file…"
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
      <span><i className="swatch heuristic" /> uncertain</span>
      <span><i className="swatch changed" /> changed</span>
      <span><i className="swatch impact" /> at risk</span>
    </div>
  );
}

function count(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
