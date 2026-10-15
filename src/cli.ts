import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from './db/database.ts';
import { getDiff } from './git/diff.ts';
import { indexRepository } from './indexer/indexer.ts';
import { bundleClient } from './server/bundle.ts';
import { startServer, type RunningServer } from './server/server.ts';

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
  xray diff [path]            List uncommitted changes and the symbols they touch (alias: xray --uncommitted)
  xray mcp <path>             Start the read-only MCP server for coding agents

Options:
  --db <file>                 Index location (default: <path>/.xray/index.db)
  --full                      Re-extract every file instead of only changed ones
  --port <number>             Port for \`serve\` (default: 4173)
  --base <ref>                Git ref to diff against (default: working tree vs HEAD)
  -h, --help                  Show this help
  -v, --version               Show the version`;

const OPTIONS = {
  db: { type: 'string' },
  full: { type: 'boolean', default: false },
  port: { type: 'string', default: '4173' },
  base: { type: 'string' },
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
      case 'mcp':
        return mcp(rest, values, io);
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

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: '?' } as const;

function diff(args: string[], values: Values, io: Io): number {
  const root = resolve(optionalSingle(args, 'diff') ?? '.');
  if (!isDirectory(root)) throw new UsageError(`Not a directory: ${root}`);
  const db = openDatabase(requireIndex(root, values));
  try {
    const base = values.base ?? 'HEAD';
    const result = getDiff(db, root, base);
    if (!result.isRepo) throw new Error(`${root} is not inside a git repository.`);
    if (result.files.length === 0) {
      io.out(`No uncommitted changes against ${base}.`);
      return 0;
    }

    const symbolCount = result.files.reduce((sum, file) => sum + file.symbolIds.length, 0);
    io.out(`${result.files.length} files changed, ${symbolCount} symbols touched (against ${base}):`);
    for (const file of result.files) {
      const from = file.oldPath ? ` (from ${file.oldPath})` : '';
      io.out(`  ${STATUS_LETTER[file.status]} ${file.path}${from}${file.indexStale ? '  [index stale]' : ''}`);
      for (const id of file.symbolIds) io.out(`      ${id.slice(id.indexOf('#') + 1)}`);
    }
    if (result.files.some((file) => file.indexStale)) {
      io.out('Some files changed since the last index; run `xray index` for exact symbol mapping.');
    }
    return 0;
  } finally {
    db.close();
  }
}

function mcp(args: string[], values: Values, io: Io): number {
  const root = requireRepo(args, 'mcp');
  requireIndex(root, values);
  return notImplemented('mcp', io);
}

function notImplemented(command: string, io: Io): number {
  io.err(`xray ${command}: not implemented yet. Run \`xray index <path>\` to build the evidence graph.`);
  return 1;
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
