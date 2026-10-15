import type { ReactNode } from 'react';
import type { AskResponse } from '../shared/api-types.ts';

export interface AnswerState {
  question: string;
  loading: boolean;
  error: string | null;
  response: AskResponse | null;
}

interface Props {
  answer: AnswerState;
  /** Shown while waiting, e.g. "openai (gpt-4.1-mini)". */
  providerLabel: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: number) => void;
}

const CITATION = /(\[(?:(?:sym|file|ext|cluster):[^\]\s]+|(?:edge|evidence):\d+)\]|`[^`]+`)/g;

/** The AI explanation, with every citation a link to the node or edge it names. */
export function AnswerView({ answer, providerLabel, onSelectNode, onSelectEdge }: Props) {
  const response = answer.response;
  const evidenceEdge = new Map(response?.evidence.edges.flatMap((edge) => edge.evidence.map((item) => [item.id, edge.id] as const)) ?? []);
  const unknown = new Set(response?.citations.unknown ?? []);

  const cite = (id: string) => {
    if (id.startsWith('edge:')) onSelectEdge(Number(id.slice(5)));
    else if (id.startsWith('evidence:')) {
      const edge = evidenceEdge.get(Number(id.slice(9)));
      if (edge !== undefined) onSelectEdge(edge);
    } else onSelectNode(id);
  };

  const inline = (text: string): ReactNode[] =>
    text.split(CITATION).map((part, i) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
      if (part.startsWith('[') && part.endsWith(']')) {
        const id = part.slice(1, -1);
        const made_up = unknown.has(id);
        return (
          <button
            key={i}
            className={`cite${made_up ? ' unknown' : ''}`}
            onClick={() => cite(id)}
            disabled={made_up}
            title={made_up ? 'Not in the evidence: this citation may be made up' : `Open ${id}`}
          >
            {shortId(id)}
          </button>
        );
      }
      return part;
    });

  return (
    <>
      <header className="panel-header">
        <div className="panel-kicker">
          <span className="pill ai">AI explanation</span>
          {response?.provider && <span className="pill subtle">{response.provider.name} · {response.provider.model}</span>}
        </div>
        <h2 className="answer-question">{answer.question}</h2>
      </header>

      {answer.loading && <p className="muted">Asking {providerLabel ?? 'the model'}, using only the traced evidence…</p>}
      {answer.error && <p className="panel-error">{answer.error}</p>}

      {response?.notice && <p className={response.answer ? 'notice' : 'notice info'}>{response.notice}</p>}

      {response?.answer && <div className="answer">{renderBlocks(response.answer, inline)}</div>}

      {response && !response.answer && response.trace.length > 0 && (
        <section className="section">
          <h3>Deterministic trace</h3>
          <pre className="trace-text">{response.trace.join('\n')}</pre>
        </section>
      )}

      {response && (
        <p className="muted small grounding">
          Grounded in {response.evidence.nodes.length} nodes, {response.evidence.edges.length} edges and {response.evidence.sources.length} source snippets from the trace.
          {response.answer && ` ${response.citations.valid.length} citations checked against that evidence.`}
        </p>
      )}
    </>
  );
}

/** Paragraphs and "- " bullet lists; nothing fancier. */
function renderBlocks(text: string, inline: (text: string) => ReactNode[]): ReactNode[] {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>);
    if (bullets.length > 0) blocks.push(<ul key={blocks.length}>{bullets.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    paragraph = [];
    bullets = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
    } else if (/^[-*•] /.test(line)) {
      if (paragraph.length > 0) flush();
      bullets.push(line.slice(2));
    } else {
      if (bullets.length > 0) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** `sym:src/auth/login.ts#login` -> `login`; `edge:12` -> `edge 12`. */
function shortId(id: string): string {
  if (id.startsWith('sym:')) return id.slice(id.indexOf('#') + 1);
  if (id.startsWith('file:')) return id.slice(id.lastIndexOf('/') + 1);
  if (id.startsWith('ext:')) return id.replace(/^ext:(npm:)?/, '');
  return id.replace(':', ' ');
}
