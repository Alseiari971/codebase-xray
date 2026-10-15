import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  AiConfigError,
  AiProviderError,
  ask,
  buildEvidencePackage,
  checkCitations,
  detectProvider,
  renderEvidence,
  SYSTEM_PROMPT,
} from '../src/ai/explain.ts';
import { main } from '../src/cli.ts';
import { openDatabase, type XrayDb } from '../src/db/database.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import type { AiStatus, AskResponse } from '../src/shared/api-types.ts';
import { copyFixture } from './helpers.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A fetch that records requests and answers with `reply` (or an error status). */
function mockFetch(reply: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let root: string;
let db: XrayDb;
before(() => {
  root = copyFixture();
  db = openDatabase(':memory:');
  indexRepository(db, root);
});
after(() => db.close());

describe('provider detection', () => {
  test('nothing configured means no provider', () => {
    assert.equal(detectProvider({}), null);
  });

  test('keys are tried in a fixed order, with per-provider default models', () => {
    assert.deepEqual(detectProvider({ OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' })?.name, 'openai');
    const anthropic = detectProvider({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })!;
    assert.deepEqual([anthropic.name, anthropic.model, anthropic.baseUrl], ['anthropic', 'claude-opus-5-5', 'https://api.anthropic.com']);
    assert.equal(detectProvider({ GEMINI_API_KEY: 'g' })?.name, 'gemini');
  });

  test('Ollama takes a host, with or without a scheme', () => {
    assert.equal(detectProvider({ OLLAMA_HOST: '127.0.0.1:11434' })?.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(detectProvider({ OLLAMA_HOST: 'https://ollama.example/' })?.baseUrl, 'https://ollama.example');
    // Named explicitly, it falls back to the default local host.
    assert.equal(detectProvider({}, { provider: 'ollama' })?.baseUrl, 'http://127.0.0.1:11434');
  });

  test('--provider and --model override, XRAY_MODEL sets the default model', () => {
    const env = { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', XRAY_MODEL: 'from-env' };
    assert.deepEqual(detectProvider(env, { provider: 'gemini' }), { name: 'gemini', model: 'from-env', apiKey: 'g', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
    assert.equal(detectProvider(env, { model: 'claude-sonnet-5-5' })?.model, 'claude-sonnet-5-5');
    assert.throws(() => detectProvider(env, { provider: 'openai' }), AiConfigError);
    assert.throws(() => detectProvider(env, { provider: 'nope' }), /Unknown provider/);
  });
});

describe('evidence package', () => {
  test('holds the traced nodes, edges with evidence ids, and numbered source', () => {
    const pkg = buildEvidencePackage(db, root, 'How does login work?');
    assert.deepEqual(pkg.keywords, ['login']);
    assert.deepEqual(pkg.entryPoints, ['sym:src/api/routes.ts#handleLogin', 'sym:src/ui/LoginForm.tsx#LoginForm']);
    assert.ok(pkg.nodes.some((node) => node.id === 'sym:src/auth/login.ts#login' && node.at === 'src/auth/login.ts:9-14' && node.depth === 1));

    const toHash = pkg.edges.find((edge) => edge.target === 'sym:src/auth/hash.ts#hashPassword')!;
    assert.equal(toHash.evidence[0]!.at, 'src/auth/login.ts:12');
    assert.match(toHash.evidence[0]!.code, /hashPassword\(password \+ pepper\)/);
    assert.equal(typeof toHash.evidence[0]!.id, 'number');

    const login = pkg.sources.find((source) => source.nodeId === 'sym:src/auth/login.ts#login')!;
    assert.match(login.code, /^ 9\| export async function login/m);
    assert.deepEqual(pkg.omitted, { nodes: 0, edges: 0 });
  });

  test('renders every id the way the model must cite it', () => {
    const text = renderEvidence(buildEvidencePackage(db, root, 'how does login work?'));
    assert.match(text, /^- \[sym:src\/auth\/login\.ts#login\] function login at src\/auth\/login\.ts:9-14 \(depth 1\)$/m);
    assert.match(text, /^- \[edge:\d+\] \[sym:src\/auth\/login\.ts#login\] calls \[sym:src\/auth\/hash\.ts#hashPassword\] \(deterministic\)$/m);
    assert.match(text, /^ {4}\[evidence:\d+\] src\/auth\/login\.ts:12: /m);
  });
});

describe('citation check', () => {
  test('separates citations in the evidence from made-up ones', () => {
    const pkg = buildEvidencePackage(db, root, 'how does login work?');
    const edge = pkg.edges[0]!;
    const answer = `It starts in [sym:src/api/routes.ts#handleLogin] via [edge:${edge.id}] [evidence:${edge.evidence[0]!.id}], then [sym:src/fake.ts#nope] and [edge:99999]. Not a citation: [1].`;
    assert.deepEqual(checkCitations(answer, pkg), {
      valid: ['sym:src/api/routes.ts#handleLogin', `edge:${edge.id}`, `evidence:${edge.evidence[0]!.id}`],
      unknown: ['sym:src/fake.ts#nope', 'edge:99999'],
    });
  });
});

describe('ask', () => {
  test('Anthropic: Messages API request with the strict prompt and only the evidence', async () => {
    const { calls, fetchImpl } = mockFetch({
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Login starts in [sym:src/api/routes.ts#handleLogin]. Inference: it is called by an HTTP route.' }],
      stop_reason: 'end_turn',
    });
    const result = await ask(db, root, 'how does login work?', { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetch: fetchImpl });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call!.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call!.headers['x-api-key'], 'sk-test');
    assert.equal(call!.headers['anthropic-version'], '2023-06-01');
    assert.equal(call!.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(call!.body.model, 'claude-opus-5-5');
    assert.equal(call!.body.fallbacks, 'default');
    assert.equal(call!.body.system, SYSTEM_PROMPT);
    assert.match(call!.body.messages[0].content, /\[sym:src\/auth\/login\.ts#login\]/);
    // Only the evidence package is sent: a file outside the trace is not.
    assert.doesNotMatch(call!.body.messages[0].content, /notify\.ts/);

    assert.equal(result.answer, 'Login starts in [sym:src/api/routes.ts#handleLogin]. Inference: it is called by an HTTP route.');
    assert.deepEqual(result.citations, { valid: ['sym:src/api/routes.ts#handleLogin'], unknown: [] });
    assert.equal(result.notice, null);
    assert.deepEqual(result.provider, { name: 'anthropic', model: 'claude-opus-5-5' });
  });

  test('older Claude models are called without effort or fallbacks', async () => {
    const { calls, fetchImpl } = mockFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    await ask(db, root, 'login', { env: { ANTHROPIC_API_KEY: 'k' }, model: 'claude-haiku-4-5', fetch: fetchImpl });
    assert.equal(calls[0]!.body.fallbacks, undefined);
    assert.equal(calls[0]!.body.output_config, undefined);
    assert.equal(calls[0]!.headers['anthropic-beta'], undefined);
  });

  test('OpenAI, Gemini and Ollama request shapes', async () => {
    const openai = mockFetch({ choices: [{ message: { content: 'from openai' } }] });
    const fromOpenai = await ask(db, root, 'login', { env: { OPENAI_API_KEY: 'sk-o' }, fetch: openai.fetchImpl });
    assert.equal(openai.calls[0]!.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(openai.calls[0]!.headers.authorization, 'Bearer sk-o');
    assert.deepEqual(openai.calls[0]!.body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
    assert.equal(fromOpenai.answer, 'from openai');

    const gemini = mockFetch({ candidates: [{ content: { parts: [{ text: 'from ' }, { text: 'gemini' }] } }] });
    const fromGemini = await ask(db, root, 'login', { env: { GEMINI_API_KEY: 'g-key' }, fetch: gemini.fetchImpl });
    assert.equal(gemini.calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(gemini.calls[0]!.headers['x-goog-api-key'], 'g-key');
    assert.equal(gemini.calls[0]!.body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
    assert.equal(fromGemini.answer, 'from gemini');

    const ollama = mockFetch({ message: { content: 'from ollama' } });
    const fromOllama = await ask(db, root, 'login', { env: { OLLAMA_HOST: 'localhost:11434' }, model: 'qwen3', fetch: ollama.fetchImpl });
    assert.equal(ollama.calls[0]!.url, 'http://localhost:11434/api/chat');
    assert.equal(ollama.calls[0]!.body.stream, false);
    assert.equal(ollama.calls[0]!.body.model, 'qwen3');
    assert.equal(fromOllama.answer, 'from ollama');
  });

  test('made-up citations are flagged in the notice', async () => {
    const { fetchImpl } = mockFetch({ choices: [{ message: { content: 'See [sym:src/auth/login.ts#login] and [sym:src/made/up.ts#ghost].' } }] });
    const result = await ask(db, root, 'login', { env: { OPENAI_API_KEY: 'k' }, fetch: fetchImpl });
    assert.deepEqual(result.citations.unknown, ['sym:src/made/up.ts#ghost']);
    assert.match(result.notice!, /may be made up: \[sym:src\/made\/up\.ts#ghost\]/);
  });

  test('without a provider it returns the trace and how to enable AI, and calls nothing', async () => {
    const { calls, fetchImpl } = mockFetch({});
    const result = await ask(db, root, 'how does login work?', { env: {}, fetch: fetchImpl });
    assert.equal(calls.length, 0);
    assert.equal(result.answer, null);
    assert.equal(result.provider, null);
    assert.match(result.notice!, /No AI provider is configured.*ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, or OLLAMA_HOST/);
    assert.equal(result.trace[0], '  handleLogin  src/api/routes.ts:3');
  });

  test('nothing matching means no model call', async () => {
    const { calls, fetchImpl } = mockFetch({});
    const result = await ask(db, root, 'how do payments work?', { env: { OPENAI_API_KEY: 'k' }, fetch: fetchImpl });
    assert.equal(calls.length, 0);
    assert.match(result.notice!, /Nothing in the code matches "payment"/);
  });

  test('provider failures and refusals become clear errors', async () => {
    const failing = mockFetch({ error: { message: 'invalid x-api-key' } }, 401);
    await assert.rejects(ask(db, root, 'login', { env: { ANTHROPIC_API_KEY: 'bad' }, fetch: failing.fetchImpl }), (error: Error) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.message, 'anthropic returned 401: invalid x-api-key');
      return true;
    });
    const refused = mockFetch({ content: [], stop_reason: 'refusal' });
    await assert.rejects(ask(db, root, 'login', { env: { ANTHROPIC_API_KEY: 'k' }, fetch: refused.fetchImpl }), /declined/);
  });
});

describe('HTTP API', () => {
  let server: RunningServer;
  let reply: unknown;
  before(async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch;
    server = await startServer({ db, root, port: 0, ai: { env: { OPENAI_API_KEY: 'k' }, fetch: fetchImpl } });
  });
  after(() => server.close());

  const post = (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('GET /api/ai reports the configured provider', async () => {
    const status = (await (await fetch(`${server.url}/api/ai`)).json()) as AiStatus;
    assert.deepEqual(status, { provider: { name: 'openai', model: 'gpt-4.1-mini' }, envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_HOST'] });
  });

  test('POST /api/ask answers from the evidence', async () => {
    reply = { choices: [{ message: { content: 'It begins at [sym:src/api/routes.ts#handleLogin].' } }] };
    const response = await post('/api/ask', { question: 'how does login work?' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as AskResponse;
    assert.deepEqual(body.citations.valid, ['sym:src/api/routes.ts#handleLogin']);
    assert.ok(body.evidence.edges.length > 0);
  });

  test('POST /api/ask validates its input and reports provider errors as 502', async () => {
    assert.equal((await post('/api/ask', {})).status, 400);
    assert.equal((await post('/api/ask', { question: 'login', provider: 'nope' })).status, 400);
    reply = 'not an object';
    const failing = await startServer({
      db,
      root,
      port: 0,
      ai: { env: { OPENAI_API_KEY: 'k' }, fetch: (async () => new Response('upstream down', { status: 503 })) as unknown as typeof fetch },
    });
    try {
      const response = await fetch(`${failing.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'login' }) });
      assert.equal(response.status, 502);
      assert.match(((await response.json()) as { error: string }).error, /openai returned 503: upstream down/);
    } finally {
      await failing.close();
    }
  });
});

describe('xray ask', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_HOST', 'XRAY_MODEL'];
  let saved: Record<string, string | undefined>;
  // The CLI reads process.env; keep real keys on this machine out of the test.
  before(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  });

  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  test('without a provider, prints the trace and which variable to set', async () => {
    const repo = copyFixture();
    await run('index', repo);
    const { code, out } = await run('ask', 'how does login work?', repo);
    assert.equal(code, 0);
    assert.match(out, /^No AI provider is configured/);
    assert.match(out, /Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, or OLLAMA_HOST/);
    assert.match(out, /handleLogin {2}src\/api\/routes\.ts:3\n {2}└─ login/);
  });

  test('usage errors', async () => {
    const repo = copyFixture();
    await run('index', repo);
    assert.equal((await run('ask')).code, 2);
    assert.equal((await run('ask', 'login', repo, '--provider', 'openai')).code, 2); // no OPENAI_API_KEY here
    assert.equal((await run('ask', 'how do payments work?', repo)).code, 1);
  });
});
