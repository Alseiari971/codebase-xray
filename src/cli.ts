import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase, type XrayDb } from './db/database.ts';
import { DEFAULT_DIFF_IMPACT_DEPTH, getDiff } from './git/diff.ts';
import { blastRadius, DEFAULT_IMPACT_DEPTH } from './graph/impact.ts';
import { traceQuestion } from './graph/question.ts';
import { resolveTarget, TargetError } from './graph/resolve.ts';
import { indexRepository } from './indexer/indexer.ts';
import { DEFAULT_QUESTION_DEPTH } from './server/flow.ts';
import { describeNodes, diffLines, exportReport, flowTree, impactLines, impactSummary, label } from './report.ts';
import { AiConfigError, ask } from './ai/explain.ts';
import { bundleClient } from './server/bundle.ts';
import { startServer, type RunningServer } from './server/server.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp/server.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Resolves when `serve` should stop. Defaults to Ctrl+C / SIGTERM. */
  untilShutdown?: (server: RunningServer) => Promise<void>;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `Codebase X-Ray - an evidence-grounded map of your codebase.

Usage:
  xray <path>                 Index <path>, then serve the map
  xray index <path>           Build or refresh the evidence graph for <path>
  xray serve <path>           Start the local web UI and HTTP/JSON API
  xray diff [path]            Uncommitted changes, the symbols they touch, and what depends on them
                              (alias: xray --uncommitted)
  xray flow <question> [path] Trace a feature, e.g. xray flow "how does checkout work?"
  xray impact <target> [path] Blast radius of a file, symbol or node id: what depends on it
  xray ask <question> [path]  Explain a feature with AI, grounded in (and citing) the evidence graph
  xray export [path]          Architecture report: --format md (default, with a Mermaid diagram) or json
  xray mcp <path>             Read-only MCP server (stdio) for Claude Code, Cursor, Windsurf, ...

Options:
  --db <file>                 Index location (default: <path>/.xray/index.db)
  --full                      Re-extract every file instead of only changed ones
  --port <number>             Port for \`serve\` (default: 4173)
  --base <ref>                Git ref to diff against (default: working tree vs HEAD)
  --depth <number>            Hops to follow for diff, flow and impact (defaults: 3, 5, 4)
  --direction <dir>           For impact: upstream (default), downstream or both
  --provider <name>           For ask: anthropic, openai, gemini or ollama (default: the first configured)
  --model <id>                For ask: the model to use (default per provider, or XRAY_MODEL)
  --format <md|json>          For export (default md)
  --out <file>                For export: write to a file instead of stdout
  -h, --help                  Show this help
  -v, --version               Show the version`;

const OPTIONS = {
  db: { type: 'string' },
  full: { type: 'boolean', default: false },
  port: { type: 'string', default: '4173' },
  base: { type: 'string' },
  depth: { type: 'string' },
  direction: { type: 'string', default: 'upstream' },
  provider: { type: 'string' },
  model: { type: 'string' },
  format: { type: 'string', default: 'md' },
  out: { type: 'string' },
  uncommitted: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class UsageError extends Error {}

export async function main(argv: string[] = process.argv.slice(2), io: Io = defaultIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });

    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    if (values.version) {
      io.out(readVersion());
      return 0;
    }
    if (values.uncommitted) return diff(positionals[0] === 'diff' ? positionals.slice(1) : positionals, values, io);

    const [command, ...rest] = positionals;
    switch (command) {
      case undefined:
        io.out(USAGE);
        return 1;
      case 'index':
        return index(rest, values, io);
      case 'serve':
        return await serve(rest, values, io);
      case 'diff':
        return diff(rest, values, io);
      case 'flow':
        return flow(rest, values, io);
      case 'impact':
        return impact(rest, values, io);
      case 'ask':
        return await askCommand(rest, values, io);
      case 'export':
        return exportCommand(rest, values, io);
      case 'mcp':
        return await mcp(rest, values, io);
      default:
        // `xray ./my-project` is the blueprint's one-shot entry point.
        if (rest.length === 0 && isDirectory(command)) {
          const code = index([command], values, io);
          return code === 0 ? await serve([command], values, io) : code;
        }
        throw new UsageError(`Unknown command or directory: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.err(`xray: ${(error as Error).message}`);
      io.err('Run `xray --help` for usage.');
      return 2;
    }
    io.err(`xray: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function index(args: string[], values: Values, io: Io): number {
  const root = requireRepo(args, 'index');
  const dbPath = dbPathFor(root, values);
  const db = openDatabase(dbPath);
  try {
    io.out(`Indexing ${root} ...`);
    const stats = indexRepository(db, root, { full: values.full });
    io.out(
      `Indexed ${stats.files} files in ${stats.durationMs} ms ` +
        `(${stats.added} added, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.removed} removed; ` +
        `${stats.skipped} skipped as unsupported).`,
    );
    io.out(stats.parsed === 0 ? 'Nothing to re-parse.' : `Parsed ${stats.parsed} files.`);
    io.out(
      `Graph: ${stats.clusters} clusters, ${stats.symbols} symbols, ${stats.imports} import edges, ` +
        `${stats.calls} call edges, ${stats.externals} external modules.`,
    );
    if (stats.unresolvedImports > 0) io.out(`${stats.unresolvedImports} imports could not be resolved to a file in the repository.`);
    io.out(`Evidence graph: ${dbPath}`);
    return 0;
  } finally {
    db.close();
  }
}

async function serve(args: string[], values: Values, io: Io): Promise<number> {
  const root = requireRepo(args, 'serve');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid --port: ${values.port}`);
  const db = openDatabase(requireIndex(root, values));
  try {
    const server = await startServer({ db, root, port }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use. Try --port ${port + 1}, or --port 0 for any free port.`);
      throw error;
    });
    try {
      await bundleClient(); // fail now rather than on the first page load
      io.out(`Codebase X-Ray is running at ${server.url}`);
      io.out('Press Ctrl+C to stop.');
      await (io.untilShutdown ?? waitForSignal)(server);
    } finally {
      await server.close();
    }
    return 0;
  } finally {
    db.close();
  }
}

function diff(args: string[], values: Values, io: Io): number {
  const root = optionalRoot(args, 0, 'diff');
  return withIndex(root, values, (db) => {
    const impactDepth = depthOption(values) ?? DEFAULT_DIFF_IMPACT_DEPTH;
    const result = getDiff(db, root, values.base ?? 'HEAD', { impactDepth });
    if (!result.isRepo) throw new Error(`${root} is not inside a git repository.`);
    for (const line of diffLines(db, result, impactDepth)) io.out(line);
    return 0;
  });
}

function flow(args: string[], values: Values, io: Io): number {
  const [question, ...rest] = args;
  if (!question) throw new UsageError('`xray flow` needs a question, e.g. xray flow "how does checkout work?"');
  const root = optionalRoot(rest, 0, 'flow');
  return withIndex(root, values, (db) => {
    const maxDepth = depthOption(values) ?? DEFAULT_QUESTION_DEPTH;
    const trace = traceQuestion(db, question, { maxDepth, relations: ['calls'] });
    if (trace.keywords.length === 0) throw new UsageError(`No searchable words in "${question}"`);
    io.out(`Keywords: ${trace.keywords.join(', ')}`);
    if (trace.entryPoints.length === 0) {
      io.out('No files or symbols match those words.');
      return 1;
    }
    const edges = db
      .prepare('SELECT source, target FROM edges WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id')
      .all(JSON.stringify(trace.edges)) as { source: string; target: string }[];
    io.out(
      `Traced ${trace.depths.size} nodes from ${trace.entryPoints.length} entry ${trace.entryPoints.length === 1 ? 'point' : 'points'} ` +
        `(calls, up to ${maxDepth} hops):`,
    );
    for (const line of flowTree(db, trace.entryPoints, edges)) io.out(line);
    return 0;
  });
}

function impact(args: string[], values: Values, io: Io): number {
  const [target, ...rest] = args;
  if (!target) throw new UsageError('`xray impact` needs a target: a file path, symbol name or node id');
  const direction = values.direction;
  if (direction !== 'upstream' && direction !== 'downstream' && direction !== 'both') {
    throw new UsageError(`Invalid --direction: ${direction}`);
  }
  const root = optionalRoot(rest, 0, 'impact');
  return withIndex(root, values, (db) => {
    const id = resolveOrUsage(db, target);
    const maxDepth = depthOption(values) ?? DEFAULT_IMPACT_DEPTH;
    const result = blastRadius(db, [id], { direction, maxDepth });
    const verb = direction === 'upstream' ? 'depend on it' : direction === 'downstream' ? 'it depends on' : 'are connected to it';
    io.out(`Blast radius of ${label(describeNodes(db, [id]).get(id), id)} (${direction}, up to ${maxDepth} hops):`);
    if (result.nodes.length === 0) {
      io.out(`  Nothing ${direction === 'upstream' ? 'depends on it' : 'is connected'} within ${maxDepth} hops.`);
      return 0;
    }
    io.out(`  ${impactSummary(result)} ${verb}.`);
    for (const line of impactLines(db, result)) io.out(line);
    return 0;
  });
}

async function askCommand(args: string[], values: Values, io: Io): Promise<number> {
  const [question, ...rest] = args;
  if (!question) throw new UsageError('`xray ask` needs a question, e.g. xray ask "how does checkout work?"');
  const root = optionalRoot(rest, 0, 'ask');
  const db = openDatabase(requireIndex(root, values));
  try {
    let result;
    try {
      result = await ask(db, root, question, { provider: values.provider, model: values.model });
    } catch (error) {
      if (error instanceof AiConfigError) throw new UsageError(error.message);
      throw error;
    }
    if (result.provider && result.answer !== null) {
      io.out(`${result.provider.name} (${result.provider.model}), from ${result.evidence.nodes.length} traced nodes and ${result.evidence.edges.length} edges:`);
      io.out('');
      io.out(result.answer);
      io.out('');
      io.out(`Citations checked: ${result.citations.valid.length} match the evidence.`);
      if (result.notice) io.err(`Warning: ${result.notice}`);
      return 0;
    }
    io.out(result.notice ?? '');
    if (result.trace.length > 0) {
      io.out('');
      for (const line of result.trace) io.out(line);
    }
    return result.trace.length > 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

function exportCommand(args: string[], values: Values, io: Io): number {
  const format = values.format;
  if (format !== 'md' && format !== 'json') throw new UsageError(`--format must be md or json, got ${format}`);
  const root = optionalRoot(args, 0, 'export');
  return withIndex(root, values, (db) => {
    const report = exportReport(db, root, format);
    if (values.out) {
      const target = resolve(values.out);
      writeFileSync(target, report);
      io.out(`Wrote ${format === 'md' ? 'the architecture report' : 'the graph snapshot'} to ${target}`);
    } else {
      io.out(report.trimEnd());
    }
    return 0;
  });
}

function resolveOrUsage(db: XrayDb, target: string): string {
  try {
    return resolveTarget(db, target);
  } catch (error) {
    if (error instanceof TargetError) throw new UsageError(error.message);
    throw error;
  }
}

function withIndex(root: string, values: Values, run: (db: XrayDb) => number): number {
  const db = openDatabase(requireIndex(root, values));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function optionalRoot(args: string[], at: number, command: string): string {
  const root = resolve(optionalSingle(args.slice(at), command) ?? '.');
  if (!isDirectory(root)) throw new UsageError(`Not a directory: ${root}`);
  return root;
}

function depthOption(values: Values): number | undefined {
  if (values.depth === undefined) return undefined;
  const depth = Number(values.depth);
  if (!Number.isInteger(depth) || depth < 1 || depth > 20) throw new UsageError(`--depth must be between 1 and 20, got ${values.depth}`);
  return depth;
}

/**
 * Speaks MCP over stdin/stdout, so nothing else may be written to stdout:
 * progress goes to stderr, which MCP clients show as server logs.
 */
async function mcp(args: string[], values: Values, io: Io): Promise<number> {
  const root = requireRepo(args, 'mcp');
  const db = openDatabase(dbPathFor(root, values));
  try {
    // Index on start (incrementally), so an agent never meets a missing or stale graph.
    const stats = indexRepository(db, root);
    io.err(`Codebase X-Ray MCP server: ${stats.files} files, ${stats.symbols} symbols indexed for ${root}.`);

    const server = createMcpServer({ db, root, version: readVersion() });
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = () => resolve();
      process.stdin.once('end', () => resolve());
    });
    await server.connect(new StdioServerTransport());
    io.err('Waiting for an MCP client on stdio.');
    await Promise.race([closed, waitForSignal()]);
    await server.close();
    return 0;
  } finally {
    db.close();
  }
}

function requireRepo(args: string[], command: string): string {
  const path = optionalSingle(args, command);
  if (path === undefined) throw new UsageError(`\`xray ${command}\` requires a <path>`);
  const root = resolve(path);
  if (!isDirectory(root)) throw new UsageError(`Not a directory: ${root}`);
  return root;
}

function requireIndex(root: string, values: Values): string {
  const dbPath = dbPathFor(root, values);
  if (!existsSync(dbPath)) throw new Error(`No index found at ${dbPath}. Run \`xray index ${root}\` first.`);
  return dbPath;
}

function optionalSingle(args: string[], command: string): string | undefined {
  if (args.length > 1) throw new UsageError(`\`xray ${command}\` takes one <path>, got ${args.length}`);
  return args[0];
}

function dbPathFor(root: string, values: Values): string {
  return values.db ? resolve(values.db) : join(root, '.xray', 'index.db');
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isParseArgsError(error: unknown): boolean {
  return error instanceof TypeError && String((error as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS');
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}
