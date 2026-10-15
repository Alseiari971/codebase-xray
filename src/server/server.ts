import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { XrayDb } from '../db/database.ts';
import { DiffBaseError, getDiff } from '../git/diff.ts';
import type { ApiError, FlowRequest } from '../shared/api-types.ts';
import { bundleClient } from './bundle.ts';
import { FlowRequestError, traceFlow } from './flow.ts';
import { getEdgeEvidence, getGraph, getNodeEvidence, NotFoundError } from './queries.ts';

export interface ServerOptions {
  db: XrayDb;
  /** Repository root; evidence is read from files under it. */
  root: string;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codebase X-Ray</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
`;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

class BadRequestError extends Error {}

/**
 * Serves the HTTP/JSON API and the web UI on loopback only. Requests must
 * carry a localhost Host header, so a web page cannot use DNS rebinding to
 * read your source code through this server.
 */
export function startServer(options: ServerOptions): Promise<RunningServer> {
  const { db, root } = options;
  const host = options.host ?? '127.0.0.1';
  let port = 0;

  const routes: { method: string; pattern: RegExp; handle: (match: RegExpExecArray, req: IncomingMessage, url: URL) => Promise<Response> | Response }[] = [
    { method: 'GET', pattern: /^\/$/, handle: () => ({ status: 200, type: 'text/html; charset=utf-8', body: INDEX_HTML }) },
    {
      method: 'GET',
      pattern: /^\/assets\/app\.(js|css)$/,
      handle: async (match) => {
        const bundle = await bundleClient();
        return match[1] === 'js'
          ? { status: 200, type: 'text/javascript; charset=utf-8', body: bundle.js }
          : { status: 200, type: 'text/css; charset=utf-8', body: bundle.css };
      },
    },
    { method: 'GET', pattern: /^\/api\/graph$/, handle: () => json(getGraph(db, root)) },
    {
      method: 'GET',
      pattern: /^\/api\/node\/(.+)\/evidence$/,
      handle: (match) => json(getNodeEvidence(db, root, decodeURIComponent(match[1]!))),
    },
    {
      method: 'GET',
      pattern: /^\/api\/edge\/(\d+)\/evidence$/,
      handle: (match) => json(getEdgeEvidence(db, root, Number(match[1]))),
    },
    {
      method: 'POST',
      pattern: /^\/api\/flow$/,
      handle: async (_match, req) => json(traceFlow(db, (await readJson(req)) as FlowRequest)),
    },
    {
      method: 'GET',
      pattern: /^\/api\/diff$/,
      handle: (_match, _req, url) => json(getDiff(db, root, url.searchParams.get('base') ?? undefined)),
    },
  ];

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLocalHost(req.headers.host, port)) {
        send(res, { status: 403, type: 'application/json', body: JSON.stringify({ error: 'Forbidden host' } satisfies ApiError) });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        if (req.method !== route.method && !(req.method === 'HEAD' && route.method === 'GET')) {
          send(res, errorResponse(405, `Use ${route.method} for ${url.pathname}`));
          return;
        }
        send(res, await route.handle(match, req, url));
        return;
      }
      send(res, errorResponse(404, `No route for ${url.pathname}`));
    } catch (error) {
      send(res, toErrorResponse(error));
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4173, host, () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

interface Response {
  status: number;
  type: string;
  body: string;
}

function json(body: unknown, status = 200): Response {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message } satisfies ApiError, status);
}

function toErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NotFoundError) return errorResponse(404, message);
  if (error instanceof BadRequestError || error instanceof FlowRequestError || error instanceof DiffBaseError) {
    return errorResponse(400, message);
  }
  return errorResponse(500, message);
}

function send(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, {
    ...SECURITY_HEADERS,
    'content-type': response.type,
    'cache-control': 'no-store',
  });
  res.end(res.req.method === 'HEAD' ? undefined : response.body);
}

function isLocalHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.toLowerCase());
  return match !== null && LOCAL_HOSTNAMES.has(match[1]!) && Number(match[2] ?? 80) === port;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Also stops plain HTML form posts from other sites, which cannot send JSON.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new BadRequestError('Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequestError('Request body is not valid JSON');
  }
}
