import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from './db/database.ts';
import { indexRepository } from './indexer/indexer.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
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
  xray diff [path]            Overlay uncommitted changes on the map (alias: xray --uncommitted)
  xray mcp <path>             Start the read-only MCP server for coding agents

Options:
  --db <file>                 Index location (default: <path>/.xray/index.db)
  --port <number>             Port for \`serve\` (default: 4173)
  --base <ref>                Git ref to diff against (default: working tree vs HEAD)
  -h, --help                  Show this help
  -v, --version               Show the version`;

const OPTIONS = {
  db: { type: 'string' },
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
        return serve(rest, values, io);
      case 'diff':
        return diff(rest, values, io);
      case 'mcp':
        return mcp(rest, values, io);
      default:
        // `xray ./my-project` is the blueprint's one-shot entry point.
        if (rest.length === 0 && isDirectory(command)) {
          const code = index([command], values, io);
          return code === 0 ? serve([command], values, io) : code;
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
    const stats = indexRepository(db, root);
    io.out(
      `Indexed ${stats.files} files in ${stats.durationMs} ms ` +
        `(${stats.added} added, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.removed} removed, ` +
        `${stats.skipped} skipped as unsupported).`,
    );
    io.out(`Evidence graph: ${dbPath}`);
    return 0;
  } finally {
    db.close();
  }
}

function serve(args: string[], values: Values, io: Io): number {
  const root = requireRepo(args, 'serve');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid --port: ${values.port}`);
  requireIndex(root, values);
  return notImplemented('serve', io);
}

function diff(args: string[], values: Values, io: Io): number {
  const root = resolve(optionalSingle(args, 'diff') ?? '.');
  if (!isDirectory(root)) throw new UsageError(`Not a directory: ${root}`);
  requireIndex(root, values);
  return notImplemented('diff', io);
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
