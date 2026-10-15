// Shared plumbing for the Tree-sitter adapters (C/C++, Python). Tree-sitter
// runs as WebAssembly, so nothing is compiled on install; the grammars come
// prebuilt in @vscode/tree-sitter-wasm. Loading is asynchronous, so call
// loadTreeSitter() once before indexing; parsing itself is synchronous.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as TreeSitter from '@vscode/tree-sitter-wasm';
import { symbolNodeId } from '../graph/ids.ts';
import type { ExtractedEvidence, ExtractedSymbol } from './types.ts';

export type SyntaxNode = TreeSitter.Node;
export type Grammar = 'cpp' | 'python';

const require = createRequire(import.meta.url);

let runtime: typeof TreeSitter | null = null;
const parsers = new Map<Grammar, TreeSitter.Parser>();
let loading: Promise<void> | null = null;

/** Loads the runtime and grammars once; later calls return the same promise. */
export function loadTreeSitter(): Promise<void> {
  loading ??= (async () => {
    const module = require('@vscode/tree-sitter-wasm') as typeof TreeSitter;
    const folder = dirname(require.resolve('@vscode/tree-sitter-wasm'));
    await module.Parser.init({ locateFile: (file: string) => join(folder, file) });
    for (const grammar of ['cpp', 'python'] as const) {
      const parser = new module.Parser();
      parser.setLanguage(await module.Language.load(join(folder, `tree-sitter-${grammar}.wasm`)));
      parsers.set(grammar, parser);
    }
    runtime = module;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function treeSitterReady(): boolean {
  return runtime !== null;
}

/** Parses `source` and hands the root to `read`; the tree is freed afterwards (it lives in WebAssembly memory). */
export function withTree<T>(grammar: Grammar, source: string, read: (root: SyntaxNode) => T): T {
  const parser = parsers.get(grammar);
  if (!parser) throw new Error('Tree-sitter is not loaded; call loadParsers() before indexing C/C++ or Python');
  const tree = parser.parse(source);
  if (!tree) throw new Error('Tree-sitter returned no tree');
  try {
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** 1-based line numbers, as stored in the index. */
export function lineRange(node: SyntaxNode): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

export function evidenceFor(lines: string[], startLine: number, endLine: number, rule: string): ExtractedEvidence {
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  return { startLine, endLine, rule, excerptHash: createHash('sha256').update(excerpt).digest('hex') };
}

/** Builds a file's symbols with stable ids; a repeated name (overloads) is told apart by its line. */
export class SymbolTable {
  readonly symbols: ExtractedSymbol[] = [];
  private readonly used = new Set<string>();

  constructor(private readonly path: string) {}

  add(
    node: SyntaxNode,
    type: ExtractedSymbol['type'],
    name: string,
    qualifiedName: string,
    metadata: Record<string, unknown>,
    parent?: ExtractedSymbol,
  ): ExtractedSymbol {
    const range = lineRange(node);
    let id = symbolNodeId(this.path, qualifiedName);
    if (this.used.has(id)) id = symbolNodeId(this.path, `${qualifiedName}@${range.startLine}`);
    this.used.add(id);
    const symbol: ExtractedSymbol = { id, parentId: parent?.id, type, name, qualifiedName, ...range, metadata };
    this.symbols.push(symbol);
    return symbol;
  }
}

/** A call site found while parsing, resolved to a symbol once every file's symbols are known. */
export interface RawCall {
  /** The enclosing symbol, or the file at module level. */
  caller: string;
  /** `plain` f(), `self` this->f() / self.f(), `member` obj.f(), `scoped` A::f() / mod.f(), `new` new T(). */
  kind: 'plain' | 'self' | 'member' | 'scoped' | 'new';
  name: string;
  /** For `scoped`: what comes before the name (`A` in A::f, `mod` in mod.f). */
  scope?: string;
  startLine: number;
  endLine: number;
}

/** Normalises a repo-relative path with `.` and `..` segments; undefined if it climbs out of the repository. */
export function normalisePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

export function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** How many leading folders two paths share: used to pick the nearest of several candidates. */
export function sharedFolders(a: string, b: string): number {
  const x = folderOf(a).split('/');
  const y = folderOf(b).split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}
