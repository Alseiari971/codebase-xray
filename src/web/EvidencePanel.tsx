import { useEffect, useState } from 'react';
import type { ChangedFile, GraphEdge, GraphNode, Overview, ResolutionType, Snippet, Tour } from '../shared/api-types.ts';
import { api } from './api.ts';
import { AnswerView, type AnswerState } from './AnswerView.tsx';
import type { GraphIndex, VisibleEdge } from './model.ts';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; edge: VisibleEdge } | { kind: 'answer' } | null;

interface Props {
  index: GraphIndex;
  selection: Selection;
  expanded: ReadonlySet<string>;
  changedFiles: Map<string, ChangedFile>;
  changedIds: ReadonlySet<string>;
  onSelectNode: (id: string) => void;
  onToggle: (id: string) => void;
  onTraceFrom: (id: string) => void;
  onTraceTo: (id: string) => void;
  onImpact: (id: string) => void;
  onFocus: (id: string) => void;
  onShowInMap: (id: string) => void;
  answer: AnswerState | null;
  aiLabel: string | null;
  onSelectEdgeId: (id: number) => void;
  overview: Overview | null;
  onMainPath: () => void;
  onTour: (tour: Tour) => void;
}

/** Fetches whenever `key` changes and ignores responses for a key that is no longer current. */
function useFetch<T>(key: string | null, load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (key === null) return;
    let current = true;
    load().then(
      (data) => current && setState({ key, data, error: null }),
      (error: unknown) => current && setState({ key, data: null, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
    // `load` is derived from `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = state.key === key;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: key !== null && !fresh };
}

export function EvidencePanel(props: Props) {
  const { selection } = props;
  if (!selection) {
    return (
      <aside className="panel">
        <div className="panel-empty">
          <h2>Where to start</h2>
          <StartHere {...props} />
          <p className="hint">
            Or search for any function or file, ask <em>how does … work?</em> in the trace box, or double-click a file on the map. Click any
            node for its source code, and any arrow for the exact lines that prove it.
          </p>
        </div>
      </aside>
    );
  }
  return (
    <aside className="panel">
      {selection.kind === 'node' && <NodeDetails {...props} id={selection.id} />}
      {selection.kind === 'edge' && <EdgeDetails {...props} edge={selection.edge} />}
      {selection.kind === 'answer' && props.answer && (
        <AnswerView answer={props.answer} providerLabel={props.aiLabel} onSelectNode={props.onSelectNode} onSelectEdge={props.onSelectEdgeId} />
      )}
    </aside>
  );
}

/** One-click starting points, worked out from the graph: the main execution path and a tour per important folder. */
function StartHere({ overview, index, onMainPath, onTour }: Props) {
  if (!overview) return <p className="muted">Loading starting points…</p>;
  const entry = overview.mainPath.entry ? index.nodes.get(overview.mainPath.entry) : undefined;
  return (
    <div className="start-here">
      {entry && (
        <button className="start-button main" onClick={onMainPath}>
          <span className="start-title">▶ Main execution path</span>
          <span className="start-sub">
            {overview.mainPath.nodes.length} files from <code>{entry.path}</code>
          </span>
        </button>
      )}
      {overview.tours.map((tour) => (
        <button key={tour.id} className="start-button" onClick={() => onTour(tour)} title={`Focus on ${tour.start} in ${tour.path}`}>
          <span className="start-title">{tour.title}</span>
          <span className="start-sub">
            starts at <code>{tour.start}</code> · {tour.path}
          </span>
        </button>
      ))}
    </div>
  );
}

function NodeDetails({ id, index, expanded, changedFiles, changedIds, onSelectNode, onToggle, onTraceFrom, onTraceTo, onImpact, onFocus, onShowInMap }: Props & { id: string }) {
  const node = index.nodes.get(id);
  const evidence = useFetch(id, () => api.nodeEvidence(id));
  if (!node) return <p className="panel-error">Node not found: {id}</p>;

  const children = index.children.get(id) ?? [];
  const outgoing = index.outgoing.get(id) ?? [];
  const incoming = index.incoming.get(id) ?? [];
  const change = node.path ? changedFiles.get(node.path) : undefined;

  return (
    <>
      <header className="panel-header">
        <div className="panel-kicker">
          <span className={`pill layer-${node.layer}`}>{node.layer === 'symbol' ? node.type : node.layer}</span>
          {changedIds.has(id) && <span className="pill changed">changed{change ? ` (${change.status})` : ''}</span>}
        </div>
        <h2>{node.symbol ?? node.name}</h2>
        <p className="panel-id" title="The id MCP tools and the API use for this node">
          <code>{node.id}</code>
        </p>
        {node.path && (
          <p className="panel-path">
            {node.path}
            {node.startLine ? `:${node.startLine}-${node.endLine}` : ''}
          </p>
        )}
        <div className="panel-actions">
          <button className="primary" onClick={() => onFocus(id)} title="Show only this and what it is connected to">
            Focus
          </button>
          <button className="danger" onClick={() => onImpact(id)} title="What depends on this, up to 4 hops away">
            Blast radius
          </button>
          <button onClick={() => onTraceFrom(id)} title="Start a path trace here">Path from</button>
          <button onClick={() => onTraceTo(id)} title="End a path trace here">Path to</button>
          <button onClick={() => onShowInMap(id)} title="Show where this sits in the cluster map">On map</button>
          {children.length > 0 && expanded.has(id) && <button onClick={() => onToggle(id)}>Collapse</button>}
        </div>
      </header>

      {change?.indexStale && (
        <p className="notice">This file changed since it was indexed. Re-run <code>xray index</code> for exact line mapping.</p>
      )}

      <Section title="Source">
        {evidence.loading && <p className="muted">Loading…</p>}
        {evidence.error && <p className="panel-error">{evidence.error}</p>}
        {evidence.data && evidence.data.snippets.length === 0 && (
          <p className="muted">{node.layer === 'cluster' ? 'A cluster groups files; expand it or pick a file below.' : 'No source lines for this node.'}</p>
        )}
        {evidence.data?.snippets.map((snippet, i) => (
          <SnippetView key={i} snippet={snippet} changedLines={change ? changedLineTest(change) : undefined} />
        ))}
      </Section>

      {children.length > 0 && (
        <Section title={`Contains (${children.length})`}>
          <NodeList nodes={children} onSelect={onSelectNode} changedIds={changedIds} />
        </Section>
      )}
      <Connections title="Depends on" edges={outgoing} side="target" index={index} onSelect={onSelectNode} />
      <Connections title="Used by" edges={incoming} side="source" index={index} onSelect={onSelectNode} />
    </>
  );
}

function EdgeDetails({ edge, index, onSelectNode }: Props & { edge: VisibleEdge }) {
  const source = index.nodes.get(edge.source);
  const target = index.nodes.get(edge.target);
  const shown = edge.edgeIds.slice(0, 10);

  return (
    <>
      <header className="panel-header">
        <div className="panel-kicker">
          {edge.relations.map((relation) => (
            <span key={relation} className="pill">{relation}</span>
          ))}
          <TrustBadge type={edge.resolutionType} confidence={edge.confidence} />
        </div>
        <h2 className="edge-title">
          <button className="link" onClick={() => onSelectNode(edge.source)}>{source?.name}</button>
          <span className="arrow">→</span>
          <button className="link" onClick={() => onSelectNode(edge.target)}>{target?.name}</button>
        </h2>
        {edge.edgeIds.length > 1 && (
          <p className="muted">
            Rolled up from {edge.edgeIds.length} relationships between the nodes inside
            {edge.deterministicCount < edge.edgeIds.length
              ? `: ${edge.deterministicCount} deterministic, ${edge.edgeIds.length - edge.deterministicCount} uncertain`
              : ''}
            .{edge.edgeIds.length > shown.length ? ` Showing the first ${shown.length}.` : ''}
          </p>
        )}
      </header>
      {shown.map((edgeId) => (
        <UnderlyingEdge key={edgeId} edge={index.edgesById.get(edgeId)!} index={index} onSelectNode={onSelectNode} />
      ))}
    </>
  );
}

function UnderlyingEdge({ edge, index, onSelectNode }: { edge: GraphEdge; index: GraphIndex; onSelectNode: (id: string) => void }) {
  const evidence = useFetch(String(edge.id), () => api.edgeEvidence(edge.id));
  const members = Array.isArray(edge.metadata.members) ? (edge.metadata.members as string[]) : [];
  return (
    <section className="section">
      <div className="underlying-title">
        <button className="link" onClick={() => onSelectNode(edge.source)}>{label(index.nodes.get(edge.source))}</button>
        <span className="arrow">{edge.relation === 'imports' ? 'imports' : 'calls'}</span>
        <button className="link" onClick={() => onSelectNode(edge.target)}>{label(index.nodes.get(edge.target))}</button>
        {members.length > 0 && <span className="muted"> ({members.join(', ')})</span>}
        <TrustBadge type={edge.resolutionType} confidence={edge.confidence} />
        <span className="muted small" title="Edge id, as returned by the API and MCP tools">edge #{edge.id}</span>
      </div>
      {evidence.loading && <p className="muted">Loading…</p>}
      {evidence.error && <p className="panel-error">{evidence.error}</p>}
      {evidence.data?.snippets.map((snippet, i) => <SnippetView key={i} snippet={snippet} />)}
    </section>
  );
}

/** Lines added or edited in the working tree, from the diff's hunks. */
function changedLineTest(change: ChangedFile): (line: number) => boolean {
  if (change.status === 'untracked' || change.status === 'added') return () => true;
  return (line) => change.hunks.some((hunk) => hunk.newLines > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newLines);
}

function SnippetView({ snippet, changedLines }: { snippet: Snippet; changedLines?: (line: number) => boolean }) {
  const first = snippet.lines[0]?.number ?? 1;
  const last = snippet.lines.at(-1)?.number ?? 1;
  const wholeFile = snippet.rule === null && snippet.startLine === 1 && first === 1 && (snippet.truncated || last === snippet.endLine);
  return (
    <figure className="snippet">
      <figcaption>
        <span className="snippet-path">
          {snippet.filePath}:{snippet.startLine}
          {snippet.endLine !== snippet.startLine ? `-${snippet.endLine}` : ''}
        </span>
        {snippet.rule && <span className="pill subtle">{snippet.rule}</span>}
        {snippet.evidenceId !== undefined && (
          <span className="muted small" title="Evidence id, as returned by the API and MCP tools">evidence #{snippet.evidenceId}</span>
        )}
        {snippet.stale && <span className="pill warn" title="The file changed since indexing; these lines may have moved.">stale</span>}
      </figcaption>
      <pre>
        {snippet.lines.map((line) => {
          const cited = !wholeFile && line.number >= snippet.startLine && line.number <= snippet.endLine;
          const changed = changedLines?.(line.number) ?? false;
          return (
            <div key={line.number} className={`line${cited ? ' cited' : ''}${changed ? ' changed' : ''}`} title={changed ? 'Changed in the working tree' : undefined}>
              <span className="ln">{line.number}</span>
              <code>{line.text || ' '}</code>
            </div>
          );
        })}
      </pre>
      {snippet.truncated && <p className="muted small">Truncated. Open the file for the rest.</p>}
    </figure>
  );
}

const TRUST_LABEL: Record<ResolutionType, string> = {
  deterministic: 'Deterministic',
  heuristic: 'Heuristic',
  runtime_observed: 'Runtime observed',
  ai_inferred: 'AI inferred',
};

function TrustBadge({ type, confidence }: { type: ResolutionType; confidence: number }) {
  return (
    <span className={`pill trust-${type}`} title={`Resolution: ${type}, confidence ${confidence}`}>
      {TRUST_LABEL[type]}
      {confidence < 1 ? ` · ${Math.round(confidence * 100)}%` : ''}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const LIST_LIMIT = 40;

function NodeList({ nodes, onSelect, changedIds }: { nodes: GraphNode[]; onSelect: (id: string) => void; changedIds: ReadonlySet<string> }) {
  return (
    <ul className="node-list">
      {nodes.slice(0, LIST_LIMIT).map((node) => (
        <li key={node.id}>
          <button className="link" onClick={() => onSelect(node.id)}>
            <span className={`dot layer-${node.layer}`} />
            {node.layer === 'symbol' ? `${node.name}` : node.name}
            <span className="muted small"> {node.layer === 'symbol' ? node.type : node.layer}</span>
            {changedIds.has(node.id) && <span className="pill changed small">changed</span>}
          </button>
        </li>
      ))}
      {nodes.length > LIST_LIMIT && <li className="muted small">…and {nodes.length - LIST_LIMIT} more</li>}
    </ul>
  );
}

function Connections({ title, edges, side, index, onSelect }: { title: string; edges: GraphEdge[]; side: 'source' | 'target'; index: GraphIndex; onSelect: (id: string) => void }) {
  if (edges.length === 0) return null;
  return (
    <Section title={`${title} (${edges.length})`}>
      <ul className="node-list">
        {edges.slice(0, LIST_LIMIT).map((edge) => {
          const other = index.nodes.get(edge[side]);
          return (
            <li key={edge.id}>
              <button className="link" onClick={() => onSelect(edge[side])}>
                <span className={`dot layer-${other?.layer ?? 'external'}`} />
                {label(other)}
                <span className="muted small"> {edge.relation}</span>
                {edge.resolutionType !== 'deterministic' && <span className={`pill small trust-${edge.resolutionType}`}>{TRUST_LABEL[edge.resolutionType]}</span>}
              </button>
            </li>
          );
        })}
        {edges.length > LIST_LIMIT && <li className="muted small">…and {edges.length - LIST_LIMIT} more</li>}
      </ul>
    </Section>
  );
}

function label(node: GraphNode | undefined): string {
  if (!node) return '?';
  if (node.layer === 'symbol') return node.symbol ?? node.name;
  if (node.layer === 'file') return node.path ?? node.name;
  return node.name;
}
