// Grounded, bring-your-own-key explanations (blueprint MVP-3).
//
// The model never sees the repository. It sees only the evidence package that
// the deterministic tracer already found for the question: matched entry
// points, traced nodes and edges with their evidence ids, and a few source
// snippets. It must cite those ids, and every citation in the answer is
// checked against the package afterwards. Plain fetch, no SDKs.

import type { XrayDb } from '../db/database.ts';
import { traceQuestion } from '../graph/question.ts';
import { flowTree } from '../report.ts';
import { getEdgeEvidence, getNodeEvidence } from '../server/queries.ts';
import type { AiProviderName, AskResponse, EvidencePackage, ResolutionType, Snippet } from '../shared/api-types.ts';

export interface Provider {
  name: AiProviderName;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface AskOptions {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to the global fetch; tests pass a mock. */
  fetch?: typeof fetch;
  provider?: string;
  model?: string;
}

export class AiConfigError extends Error {}
export class AiProviderError extends Error {}

/** Tried in this order when no provider is named. */
export const PROVIDER_ENV: Record<AiProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_HOST',
};

/** Override with --model or XRAY_MODEL. */
export const DEFAULT_MODELS: Record<AiProviderName, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.1',
};

const PROVIDERS = Object.keys(PROVIDER_ENV) as AiProviderName[];

export function detectProvider(env: Record<string, string | undefined>, overrides: { provider?: string; model?: string } = {}): Provider | null {
  let name: AiProviderName | undefined;
  if (overrides.provider) {
    if (!PROVIDERS.includes(overrides.provider as AiProviderName)) {
      throw new AiConfigError(`Unknown provider "${overrides.provider}"; use one of ${PROVIDERS.join(', ')}`);
    }
    name = overrides.provider as AiProviderName;
    // A local Ollama needs no key; the others do.
    if (name !== 'ollama' && !env[PROVIDER_ENV[name]]) throw new AiConfigError(`--provider ${name} needs ${PROVIDER_ENV[name]} to be set`);
  } else {
    name = PROVIDERS.find((candidate) => env[PROVIDER_ENV[candidate]]);
  }
  if (!name) return null;

  const model = overrides.model ?? env.XRAY_MODEL ?? DEFAULT_MODELS[name];
  switch (name) {
    case 'anthropic':
      return { name, model, apiKey: env.ANTHROPIC_API_KEY, baseUrl: trimSlash(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com') };
    case 'openai':
      return { name, model, apiKey: env.OPENAI_API_KEY, baseUrl: trimSlash(env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1') };
    case 'gemini':
      return { name, model, apiKey: env.GEMINI_API_KEY, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' };
    case 'ollama': {
      const host = env.OLLAMA_HOST || '127.0.0.1:11434';
      return { name, model, baseUrl: trimSlash(/^https?:\/\//.test(host) ? host : `http://${host}`) };
    }
  }
}

const LIMITS = { nodes: 30, edges: 40, evidencePerEdge: 2, sources: 8, sourceLines: 60 };

/** The deterministic trace for `question`, cut down to what a model needs to explain it. */
export function buildEvidencePackage(db: XrayDb, root: string, question: string): EvidencePackage {
  const trace = traceQuestion(db, question, { maxDepth: 5, relations: ['calls'] });
  const ordered = [...trace.depths].sort(([a, da], [b, db_]) => da - db_ || a.localeCompare(b)).map(([id]) => id);
  const kept = new Set(ordered.slice(0, LIMITS.nodes));

  const info = new Map(
    (db
      .prepare('SELECT id, layer, type, name, symbol, path, start_line, end_line FROM nodes WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...kept])) as { id: string; layer: string; type: string; name: string; symbol: string | null; path: string | null; start_line: number | null; end_line: number | null }[]).map((row) => [row.id, row]),
  );
  const nodes = [...kept].flatMap((id) => {
    const row = info.get(id);
    if (!row) return [];
    const at = row.path ? (row.start_line ? `${row.path}:${row.start_line}-${row.end_line}` : row.path) : null;
    return [{ id, kind: row.layer === 'symbol' ? row.type : row.layer === 'external' ? 'package' : row.layer, name: row.symbol ?? row.name, at, depth: trace.depths.get(id)! }];
  });

  const edgeRows = db
    .prepare('SELECT id, source, target, relation, resolution_type, confidence FROM edges WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(trace.edges)) as { id: number; source: string; target: string; relation: string; resolution_type: ResolutionType; confidence: number }[];
  const inside = edgeRows.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  const edges = inside.slice(0, LIMITS.edges).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    resolutionType: edge.resolution_type,
    confidence: edge.confidence,
    evidence: getEdgeEvidence(db, root, edge.id)
      .snippets.slice(0, LIMITS.evidencePerEdge)
      .map((snippet) => ({ id: snippet.evidenceId!, at: location(snippet), code: citedLines(snippet) })),
  }));

  // Source for the entry points first, then the nearest symbols.
  const sourceIds = [...new Set([...trace.entryPoints, ...nodes.filter((node) => info.get(node.id)?.layer === 'symbol').map((node) => node.id)])].slice(0, LIMITS.sources);
  const sources = sourceIds.flatMap((id) =>
    getNodeEvidence(db, root, id).snippets.slice(0, 1).map((snippet) => ({ nodeId: id, at: location(snippet), code: numbered(snippet, LIMITS.sourceLines) })),
  );

  return {
    question,
    keywords: trace.keywords,
    entryPoints: trace.entryPoints,
    nodes,
    edges,
    sources,
    omitted: { nodes: ordered.length - nodes.length, edges: edgeRows.length - edges.length },
  };
}

export const SYSTEM_PROMPT = `You explain how a codebase works, using ONLY the evidence you are given. The evidence was extracted from the repository by Codebase X-Ray's parsers, not by a model.

Rules:
- Cite every factual claim inline, in square brackets, with ids that appear in the evidence: node ids such as [sym:src/auth/login.ts#login] or [file:src/auth/login.ts], edges as [edge:12], evidence as [evidence:34].
- Never invent ids, files, functions or behaviour that the evidence does not show.
- When you go beyond the evidence (for example, guessing intent, or what code you were not shown does), start that sentence with "Inference:" and mark it unverified.
- Edges marked heuristic are likely but not proven; say so when you rely on one.
- If the evidence does not answer the question, say so plainly and say what is missing.
- Be concise: one or two sentences of overview, then the flow step by step as "- " bullets. Plain text, no headings.`;

/** The package as text for the model, with every id written the way it must be cited. */
export function renderEvidence(pkg: EvidencePackage): string {
  const lines = [`Question: ${pkg.question}`, `Keywords matched: ${pkg.keywords.join(', ') || '(none)'}`, `Entry points: ${pkg.entryPoints.map((id) => `[${id}]`).join(', ') || '(none)'}`, '', 'Nodes (depth = hops from an entry point):'];
  for (const node of pkg.nodes) lines.push(`- [${node.id}] ${node.kind} ${node.name}${node.at ? ` at ${node.at}` : ''} (depth ${node.depth})`);
  lines.push('', 'Edges:');
  for (const edge of pkg.edges) {
    const trust = edge.resolutionType === 'deterministic' ? 'deterministic' : `${edge.resolutionType}, confidence ${edge.confidence}`;
    lines.push(`- [edge:${edge.id}] [${edge.source}] ${edge.relation} [${edge.target}] (${trust})`);
    for (const item of edge.evidence) lines.push(`    [evidence:${item.id}] ${item.at}: ${item.code}`);
  }
  lines.push('', 'Source:');
  for (const source of pkg.sources) lines.push(`[${source.nodeId}] ${source.at}`, '```', source.code, '```');
  if (pkg.omitted.nodes + pkg.omitted.edges > 0) {
    lines.push('', `(${pkg.omitted.nodes} more nodes and ${pkg.omitted.edges} more edges were traced but left out for size.)`);
  }
  return lines.join('\n');
}

const CITATION = /\[((?:sym|file|ext|cluster):[^\]\s]+|(?:edge|evidence):\d+)\]/g;

/** Which ids the answer cites, split by whether the evidence package contains them. */
export function checkCitations(answer: string, pkg: EvidencePackage): { valid: string[]; unknown: string[] } {
  const known = new Set<string>([
    ...pkg.nodes.map((node) => node.id),
    ...pkg.entryPoints,
    ...pkg.sources.map((source) => source.nodeId),
    ...pkg.edges.flatMap((edge) => [`edge:${edge.id}`, edge.source, edge.target, ...edge.evidence.map((item) => `evidence:${item.id}`)]),
  ]);
  const cited = [...new Set([...answer.matchAll(CITATION)].map((match) => match[1]!))];
  return { valid: cited.filter((id) => known.has(id)), unknown: cited.filter((id) => !known.has(id)) };
}

export function aiHelp(): string {
  return `Set ${PROVIDER_ENV.anthropic}, ${PROVIDER_ENV.openai} or ${PROVIDER_ENV.gemini}, or ${PROVIDER_ENV.ollama} for a local model, to get a written explanation (choose with --provider and --model).`;
}

/**
 * Answers `question` from the evidence graph. Without a provider, or when
 * nothing matches, it returns the deterministic trace and a notice instead of
 * calling a model.
 */
export async function ask(db: XrayDb, root: string, question: string, options: AskOptions = {}): Promise<AskResponse> {
  const provider = detectProvider(options.env ?? process.env, { provider: options.provider, model: options.model });
  const evidence = buildEvidencePackage(db, root, question);
  const trace = evidence.entryPoints.length > 0 ? flowTree(db, evidence.entryPoints, evidence.edges) : [];
  const base = { question, provider: provider ? { name: provider.name, model: provider.model } : null, trace, evidence };

  if (evidence.keywords.length === 0 || evidence.entryPoints.length === 0) {
    const notice = evidence.keywords.length === 0 ? 'The question has no words that could name code. Ask about a feature, e.g. "how does login work?"' : `Nothing in the code matches "${evidence.keywords.join(' ')}", so there is no evidence to explain.`;
    return { ...base, answer: null, notice, citations: { valid: [], unknown: [] } };
  }
  if (!provider) {
    return { ...base, answer: null, notice: `No AI provider is configured, so here is the deterministic trace. ${aiHelp()}`, citations: { valid: [], unknown: [] } };
  }

  const answer = (await complete(provider, SYSTEM_PROMPT, renderEvidence(evidence), options.fetch ?? fetch)).trim();
  const citations = checkCitations(answer, evidence);
  const notice = citations.unknown.length > 0 ? `${citations.unknown.length} citation(s) in this answer are not in the evidence and may be made up: ${citations.unknown.map((id) => `[${id}]`).join(', ')}` : null;
  return { ...base, answer, notice, citations };
}

/** Claude models that take effort and server-side refusal fallbacks. */
const CURRENT_CLAUDE = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const TIMEOUT_MS = 180_000;

export async function complete(provider: Provider, system: string, user: string, fetchImpl: typeof fetch): Promise<string> {
  const post = async (url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiProviderError(`Could not reach ${provider.name} at ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      // Error pages are not always JSON.
    }
    if (!response.ok) {
      const message = json.error?.message ?? json.error ?? text.slice(0, 300);
      throw new AiProviderError(`${provider.name} returned ${response.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
    }
    return json;
  };

  switch (provider.name) {
    case 'anthropic': {
      const headers: Record<string, string> = { 'x-api-key': provider.apiKey ?? '', 'anthropic-version': '2023-06-01' };
      const body: Record<string, unknown> = { model: provider.model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] };
      if (CURRENT_CLAUDE.has(provider.model)) {
        body.output_config = { effort: 'medium' };
        // If a safety classifier declines, retry on a fallback model inside the same call.
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
        body.fallbacks = 'default';
      }
      const json = await post(`${provider.baseUrl}/v1/messages`, headers, body);
      if (json.stop_reason === 'refusal') throw new AiProviderError('The model declined to answer this question.');
      // Thinking blocks are skipped; only the text is the answer.
      return ((json.content ?? []) as { type: string; text?: string }[]).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    }
    case 'openai': {
      const json = await post(`${provider.baseUrl}/chat/completions`, { authorization: `Bearer ${provider.apiKey}` }, {
        model: provider.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return json.choices?.[0]?.message?.content ?? '';
    }
    case 'gemini': {
      const json = await post(`${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:generateContent`, { 'x-goog-api-key': provider.apiKey ?? '' }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
      });
      return ((json.candidates?.[0]?.content?.parts ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('');
    }
    case 'ollama': {
      const json = await post(`${provider.baseUrl}/api/chat`, {}, {
        model: provider.model,
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return json.message?.content ?? '';
    }
  }
}

function location(snippet: Snippet): string {
  return `${snippet.filePath}:${snippet.startLine}${snippet.endLine !== snippet.startLine ? `-${snippet.endLine}` : ''}`;
}

/** Just the cited lines of an evidence snippet, on one line. */
function citedLines(snippet: Snippet): string {
  return snippet.lines
    .filter((line) => line.number >= snippet.startLine && line.number <= snippet.endLine)
    .map((line) => line.text.trim())
    .join(' ')
    .slice(0, 200);
}

function numbered(snippet: Snippet, maxLines: number): string {
  const lines = snippet.lines.slice(0, maxLines);
  const width = String(lines.at(-1)?.number ?? 1).length;
  const text = lines.map((line) => `${String(line.number).padStart(width)}| ${line.text}`).join('\n');
  return snippet.lines.length > maxLines ? `${text}\n… (${snippet.lines.length - maxLines} more lines)` : text;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
