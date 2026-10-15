// "How does checkout work?" answered without an LLM: match the question's
// keywords against symbol and file names, keep the most upstream matches as
// entry points, and trace everything they reach.

import type { XrayDb } from '../db/database.ts';
import { reach } from './traverse.ts';

const STOPWORDS = new Set(
  (
    'a an and are as at be by can could do does doing done explain flow flows for from happen happens how i in ' +
    'is it its me my of on or our show tell that the this to trace up we what when where which who why with ' +
    'work works working would you your'
  ).split(' '),
);

/** Split identifiers and paths into lowercase words: `handleLogin.ts` -> handle, login, ts. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The question's words that can name code, stemmed. */
export function keywords(question: string): string[] {
  return [...new Set(words(question).filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(stem))];
}

/**
 * A deliberately crude stemmer, applied to both sides of every comparison so
 * "indexing", "indexer" and "indexes" all meet "index" in `indexRepository`.
 */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'er', 'es']) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  if (word.length > 4 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

interface Candidate {
  id: string;
  layer: 'file' | 'symbol';
  type: string;
  path: string;
  name: string;
  score: number;
}

/** 3 per keyword that is a whole word of the name, 2 for a word prefix, 1 for a folder or file name match. */
function score(candidate: Omit<Candidate, 'score'>, terms: string[]): number {
  const nameWords = words(candidate.name).map(stem);
  const pathWords = words(candidate.path).map(stem);
  let total = 0;
  for (const term of terms) {
    if (nameWords.includes(term)) total += 3;
    else if (nameWords.some((word) => word.startsWith(term) && term.length >= 3)) total += 2;
    else if (pathWords.includes(term)) total += 1;
  }
  return total;
}

export interface QuestionTrace {
  keywords: string[];
  /** Every node that matched, best first. */
  matches: string[];
  /** The most upstream matches, where the traced flow starts. */
  entryPoints: string[];
  depths: Map<string, number>;
  edges: number[];
}

const MAX_MATCHES = 30;
const MAX_ENTRY_POINTS = 5;

export function traceQuestion(db: XrayDb, question: string, options: { maxDepth: number; relations: string[] }): QuestionTrace {
  const terms = keywords(question);
  if (terms.length === 0) return { keywords: [], matches: [], entryPoints: [], depths: new Map(), edges: [] };

  // Cheap prefilter in SQL, exact scoring in TypeScript.
  const like = terms.map(() => '(lower(name) LIKE ? OR lower(path) LIKE ?)').join(' OR ');
  const rows = db
    .prepare(`SELECT id, layer, type, path, name FROM nodes WHERE layer IN ('file', 'symbol') AND (${like})`)
    .all(...terms.flatMap((term) => [`%${term}%`, `%${term}%`])) as Omit<Candidate, 'score'>[];
  // Terms are stems, so `%index%` also finds indexRepository, indexer.ts and reindex().

  const scored = rows
    .map((row) => ({ ...row, score: score(row, terms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || layerRank(a) - layerRank(b) || a.id.localeCompare(b.id));
  const best = scored[0]?.score ?? 0;
  const matched = scored.filter((candidate) => candidate.score >= best * 0.5).slice(0, MAX_MATCHES);
  const matchedIds = new Set(matched.map((candidate) => candidate.id));

  // A file whose own symbols matched is represented by those symbols.
  const matchedSymbolFiles = new Set(matched.filter((c) => c.layer === 'symbol').map((c) => c.path));
  const focused = matched.filter((c) => c.layer === 'symbol' || !matchedSymbolFiles.has(c.path));

  // Entry points: matches nothing else in the match set calls or imports.
  const calledByMatches = new Set(
    db
      .prepare(
        `SELECT DISTINCT e.target FROM edges e
         WHERE e.relation IN (SELECT value FROM json_each(@relations))
           AND e.source IN (SELECT value FROM json_each(@matches))
           AND e.target IN (SELECT value FROM json_each(@matches))
           AND e.source != e.target`,
      )
      .pluck()
      .all({ matches: JSON.stringify([...matchedIds]), relations: JSON.stringify(options.relations) }) as string[],
  );
  // Types and interfaces describe code but never run it, so they start a flow only as a last resort.
  const runnable = focused.filter((c) => c.type !== 'interface' && c.type !== 'type');
  const starts = runnable.length > 0 ? runnable : focused;
  let entryPoints = starts.filter((c) => !calledByMatches.has(c.id)).map((c) => c.id);
  // Everything calls everything else (a cycle): fall back to the best matches.
  if (entryPoints.length === 0) entryPoints = starts.map((c) => c.id);
  entryPoints = entryPoints.slice(0, MAX_ENTRY_POINTS);

  const traced = reach(db, entryPoints, { direction: 'downstream', maxDepth: options.maxDepth, relations: options.relations });
  return {
    keywords: terms,
    matches: matched.map((candidate) => candidate.id),
    entryPoints,
    depths: traced.depths,
    edges: traced.edges.map((edge) => edge.id),
  };
}

function layerRank(candidate: Candidate): number {
  return candidate.layer === 'symbol' ? 0 : 1;
}
