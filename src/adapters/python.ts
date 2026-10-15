// Python adapter on Tree-sitter. Imports are resolved against the repository's
// module layout (relative imports, packages with __init__.py, src/ layouts);
// anything else is a standard-library or PyPI package. Calls are resolved by
// name through the file's own definitions, its imports and `self`, and marked
// heuristic: Python has no static types to prove them.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { externalNodeId, fileNodeId } from '../graph/ids.ts';
import { EdgeSet } from './cpp.ts';
import { evidenceFor, folderOf, lineRange, sharedFolders, SymbolTable, treeSitterReady, withTree, type RawCall, type SyntaxNode } from './treesitter.ts';
import type { ExternalModule, ExtractedSymbol, FileExtraction, ParserAdapter } from './types.ts';

const MAX_PARSE_BYTES = 1_000_000;

interface RawImport {
  /** Dotted module, without the leading dots of a relative import. */
  module: string;
  /** Leading dots: 0 for absolute imports. */
  level: number;
  /** Names bound by `from module import a as b`: local name -> imported name. Empty for `import module`. */
  names: { local: string; imported: string }[];
  /** For `import a.b as m`, the local alias; for `import a.b`, the first segment. */
  alias?: string;
  startLine: number;
  endLine: number;
}

interface ParsedFile {
  path: string;
  symbols: ExtractedSymbol[];
  imports: RawImport[];
  calls: RawCall[];
  lines: string[];
}

export const pythonAdapter: ParserAdapter = {
  name: 'tree-sitter-python',
  supports: (language) => language === 'python',
  ready: treeSitterReady,
  extract(root, paths, indexedPaths) {
    const all = [...indexedPaths].filter((path) => path.endsWith('.py')).sort();
    const parsed = new Map(all.map((path) => [path, parseFile(root, path)]));
    const resolver = new Resolver(parsed);
    return paths.map((path) => resolver.extract(parsed.get(path) ?? { path, symbols: [], imports: [], calls: [], lines: [] }));
  },
};

function parseFile(root: string, path: string): ParsedFile {
  const absolute = join(root, path);
  if (statSync(absolute).size > MAX_PARSE_BYTES) return { path, symbols: [], imports: [], calls: [], lines: [] };
  const source = readFileSync(absolute, 'utf8');
  const fileId = fileNodeId(path);
  return withTree('python', source, (tree) => {
    const table = new SymbolTable(path);
    const calls: RawCall[] = [];

    const collectCalls = (node: SyntaxNode | null, caller: string) => {
      for (const site of node?.descendantsOfType('call') ?? []) {
        const call = site && classifyCall(site, caller);
        if (call) calls.push(call);
      }
    };

    /** A def or class, possibly behind decorators; `range` includes the decorators. */
    const visit = (node: SyntaxNode, range: SyntaxNode, owner?: ExtractedSymbol) => {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const qualified = owner ? `${owner.qualifiedName}.${name}` : name;
      const metadata = { exported: !name.startsWith('_') };
      if (node.type === 'function_definition') {
        const isAsync = node.children.some((child) => child?.type === 'async');
        const symbol = table.add(range, owner?.type === 'class' ? 'method' : 'function', name, qualified, { ...metadata, async: isAsync }, owner);
        collectCalls(node.childForFieldName('body'), symbol.id);
      } else {
        const symbol = table.add(range, 'class', name, qualified, metadata, owner);
        const body = node.childForFieldName('body');
        for (const member of body?.namedChildren ?? []) {
          if (!member) continue;
          if (isDefinition(member)) visit(definitionOf(member), member, symbol);
          else collectCalls(member, symbol.id); // class-level statements
        }
      }
    };

    for (const statement of tree.namedChildren) {
      if (!statement) continue;
      if (isDefinition(statement)) visit(definitionOf(statement), statement);
      else collectCalls(statement, fileId); // module level, e.g. `if __name__ == "__main__":`
    }

    const imports: RawImport[] = [];
    for (const statement of tree.descendantsOfType(['import_statement', 'import_from_statement'])) {
      if (statement) imports.push(...readImport(statement));
    }
    return { path, symbols: table.symbols, imports, calls, lines: source.split(/\r?\n/) };
  });
}

function isDefinition(node: SyntaxNode): boolean {
  return node.type === 'function_definition' || node.type === 'class_definition' || (node.type === 'decorated_definition' && node.childForFieldName('definition') !== null);
}

function definitionOf(node: SyntaxNode): SyntaxNode {
  return node.type === 'decorated_definition' ? node.childForFieldName('definition')! : node;
}

function readImport(statement: SyntaxNode): RawImport[] {
  const range = lineRange(statement);
  if (statement.type === 'import_statement') {
    // import a.b, c.d as e
    return statement.childrenForFieldName('name').flatMap((item) => {
      if (!item) return [];
      if (item.type === 'aliased_import') {
        const module = item.childForFieldName('name')?.text;
        return module ? [{ module, level: 0, names: [], alias: item.childForFieldName('alias')?.text, ...range }] : [];
      }
      return [{ module: item.text, level: 0, names: [], alias: item.text.split('.')[0], ...range }];
    });
  }
  // from .a.b import c as d, e
  const source = statement.childForFieldName('module_name');
  if (!source) return [];
  let module = source.text;
  let level = 0;
  if (source.type === 'relative_import') {
    const prefix = source.namedChildren.find((child) => child?.type === 'import_prefix')?.text ?? '';
    level = prefix.length;
    module = source.namedChildren.find((child) => child?.type === 'dotted_name')?.text ?? '';
  }
  const names = statement.childrenForFieldName('name').flatMap((item) => {
    if (!item) return [];
    if (item.type === 'aliased_import') {
      const imported = item.childForFieldName('name')?.text;
      return imported ? [{ imported, local: item.childForFieldName('alias')?.text ?? imported }] : [];
    }
    return [{ imported: item.text, local: item.text }];
  });
  return [{ module, level, names, ...range }];
}

function classifyCall(site: SyntaxNode, caller: string): RawCall | undefined {
  const fn = site.childForFieldName('function');
  if (!fn) return undefined;
  const startLine = site.startPosition.row + 1;
  const endLine = fn.endPosition.row + 1;
  if (fn.type === 'identifier') return { caller, kind: 'plain', name: fn.text, startLine, endLine };
  if (fn.type !== 'attribute') return undefined;
  const object = fn.childForFieldName('object');
  const name = fn.childForFieldName('attribute')?.text;
  if (!object || !name) return undefined;
  if (object.type === 'identifier' && (object.text === 'self' || object.text === 'cls')) return { caller, kind: 'self', name, startLine, endLine };
  // `mod.f()` or `pkg.mod.f()`: the scope may name a module; resolution decides.
  if (object.type === 'identifier' || object.type === 'attribute') return { caller, kind: 'scoped', name, scope: object.text, startLine, endLine };
  return { caller, kind: 'member', name, startLine, endLine };
}

/** Standard library modules: imports of these are builtins, not PyPI packages. */
const STDLIB = new Set(
  (
    'abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cmath codecs collections ' +
    'colorsys concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime ' +
    'dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ' +
    'ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib ' +
    'inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox math mimetypes mmap ' +
    'multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posix ' +
    'pprint profile pstats pty pwd queue quopri random re readline reprlib resource rlcompleter runpy sched secrets ' +
    'select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string ' +
    'stringprep struct subprocess sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time ' +
    'timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest ' +
    'urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib ' +
    'zoneinfo __future__'
  ).split(' '),
);

type Binding =
  | { kind: 'module'; path: string }
  | { kind: 'symbol'; path: string; name: string }
  | { kind: 'external'; module: ExternalModule };

class Resolver {
  /** Dotted module name (and its trailing suffixes, for src/ layouts) -> files. */
  private readonly modules = new Map<string, string[]>();
  private readonly topLevel = new Map<string, Map<string, ExtractedSymbol>>();
  private readonly methodsByName = new Map<string, (ExtractedSymbol & { path: string })[]>();

  constructor(private readonly files: Map<string, ParsedFile>) {
    for (const file of files.values()) {
      const parts = file.path.replace(/\.py$/, '').split('/');
      if (parts.at(-1) === '__init__') parts.pop();
      for (let i = 0; i < parts.length; i++) {
        const name = parts.slice(i).join('.');
        this.modules.set(name, [...(this.modules.get(name) ?? []), file.path]);
      }
      this.topLevel.set(file.path, new Map(file.symbols.filter((s) => !s.parentId).map((s) => [s.name, s])));
      for (const symbol of file.symbols.filter((s) => s.type === 'method')) {
        this.methodsByName.set(symbol.name, [...(this.methodsByName.get(symbol.name) ?? []), { ...symbol, path: file.path }]);
      }
    }
  }

  extract(file: ParsedFile): FileExtraction {
    const fileId = fileNodeId(file.path);
    const edges = new EdgeSet();
    const externals = new Map<string, ExternalModule>();
    const unresolved = new Set<string>();
    const bindings = new Map<string, Binding>();

    for (const item of file.imports) {
      const evidence = [evidenceFor(file.lines, item.startLine, item.endLine, 'tree-sitter-python:import')];
      const resolved = this.resolveModule(file.path, item.module, item.level);
      const spec = `${'.'.repeat(item.level)}${item.module}`;
      if (!resolved) {
        unresolved.add(spec);
        continue;
      }
      if (resolved.kind === 'file') {
        if (resolved.path !== file.path) {
          edges.add({ source: fileId, target: fileNodeId(resolved.path), relation: 'imports', resolutionType: resolved.exact ? 'deterministic' : 'heuristic', confidence: resolved.exact ? 1 : 0.8, metadata: { module: spec }, evidence });
        }
      } else {
        externals.set(resolved.module.id, resolved.module);
        edges.add({ source: fileId, target: resolved.module.id, relation: 'imports', resolutionType: 'deterministic', confidence: 1, metadata: { module: spec }, evidence });
      }

      if (item.names.length === 0) {
        const local = item.alias ?? item.module.split('.')[0]!;
        // `import a.b` binds `a`; `import a.b as m` binds the whole module to m.
        const target = item.alias && item.alias !== item.module.split('.')[0] ? resolved : this.resolveModule(file.path, item.module.split('.')[0]!, 0);
        if (target) bindings.set(local, target.kind === 'file' ? { kind: 'module', path: target.path } : { kind: 'external', module: target.module });
        continue;
      }
      for (const name of item.names) {
        if (resolved.kind === 'external') {
          bindings.set(name.local, { kind: 'external', module: resolved.module });
        } else if (this.topLevel.get(resolved.path)?.has(name.imported)) {
          bindings.set(name.local, { kind: 'symbol', path: resolved.path, name: name.imported });
        } else {
          // `from pkg import mod` imports a submodule: bind it, and record the import of that file too.
          const sub = this.resolveModule(file.path, [item.module, name.imported].filter(Boolean).join('.'), item.level);
          if (sub?.kind === 'file') {
            bindings.set(name.local, { kind: 'module', path: sub.path });
            if (sub.path !== file.path) {
              edges.add({ source: fileId, target: fileNodeId(sub.path), relation: 'imports', resolutionType: sub.exact ? 'deterministic' : 'heuristic', confidence: sub.exact ? 1 : 0.8, metadata: { module: `${spec}.${name.imported}` }, evidence });
            }
          }
        }
      }
    }

    const own = this.topLevel.get(file.path) ?? new Map<string, ExtractedSymbol>();
    const classOf = new Map(file.symbols.filter((s) => s.type === 'method').map((s) => [s.id, s.qualifiedName.slice(0, s.qualifiedName.lastIndexOf('.'))]));
    for (const call of file.calls) {
      const target = this.resolveCall(call, file, own, bindings, classOf.get(call.caller));
      if (!target || target.id === call.caller) continue;
      if (target.external) externals.set(target.external.id, target.external);
      edges.add({
        source: call.caller,
        target: target.id,
        relation: 'calls',
        resolutionType: 'heuristic',
        confidence: target.confidence,
        metadata: { via: call.kind, ...(target.external ? { members: [call.name] } : {}) },
        evidence: [evidenceFor(file.lines, call.startLine, call.endLine, 'tree-sitter-python:call')],
      });
    }

    return { path: file.path, symbols: file.symbols, edges: edges.values(), externals: [...externals.values()], unresolvedImports: [...unresolved].sort() };
  }

  private resolveModule(from: string, module: string, level: number): { kind: 'file'; path: string; exact: boolean } | { kind: 'external'; module: ExternalModule } | undefined {
    if (level > 0) {
      const base = folderOf(from).split('/').filter(Boolean);
      if (level - 1 > base.length) return undefined;
      const folder = [...base.slice(0, base.length - (level - 1)), ...module.split('.').filter(Boolean)].join('/');
      for (const candidate of [`${folder}.py`, `${folder}/__init__.py`]) if (this.files.has(candidate)) return { kind: 'file', path: candidate, exact: true };
      return undefined;
    }
    const exact = [`${module.replace(/\./g, '/')}.py`, `${module.replace(/\./g, '/')}/__init__.py`].find((path) => this.files.has(path));
    if (exact) return { kind: 'file', path: exact, exact: true };
    const candidates = this.modules.get(module);
    if (candidates?.length) {
      const best = [...candidates].sort((a, b) => sharedFolders(b, from) - sharedFolders(a, from) || a.length - b.length)[0]!;
      return { kind: 'file', path: best, exact: candidates.length === 1 };
    }
    const top = module.split('.')[0]!;
    return STDLIB.has(top)
      ? { kind: 'external', module: { id: externalNodeId(`python:${top}`), type: 'builtin', name: `python:${top}` } }
      : { kind: 'external', module: { id: externalNodeId(`pypi:${top}`), type: 'package', name: top } };
  }

  private resolveCall(
    call: RawCall,
    file: ParsedFile,
    own: Map<string, ExtractedSymbol>,
    bindings: Map<string, Binding>,
    callerClass: string | undefined,
  ): { id: string; confidence: number; external?: ExternalModule } | undefined {
    const symbolIn = (path: string, name: string, confidence: number) => {
      const symbol = this.topLevel.get(path)?.get(name);
      return symbol ? { id: symbol.id, confidence } : undefined;
    };
    const viaBinding = (binding: Binding | undefined, member?: string) => {
      if (!binding) return undefined;
      if (binding.kind === 'external') return { id: binding.module.id, confidence: 0.9, external: binding.module };
      if (binding.kind === 'symbol') {
        if (!member) return symbolIn(binding.path, binding.name, 0.9);
        // `Foo.create()` on an imported class.
        const method = this.files.get(binding.path)?.symbols.find((s) => s.qualifiedName === `${binding.name}.${member}`);
        return method ? { id: method.id, confidence: 0.85 } : undefined;
      }
      return member ? symbolIn(binding.path, member, 0.9) : undefined;
    };

    switch (call.kind) {
      case 'plain': {
        const local = own.get(call.name);
        if (local) return { id: local.id, confidence: 0.9 };
        return viaBinding(bindings.get(call.name));
      }
      case 'self': {
        if (!callerClass) return undefined;
        const method = file.symbols.find((s) => s.qualifiedName === `${callerClass}.${call.name}`);
        return method ? { id: method.id, confidence: 0.85 } : undefined;
      }
      case 'scoped': {
        const scope = call.scope!;
        const head = scope.split('.')[0]!;
        const binding = bindings.get(head);
        if (binding && scope === head) return viaBinding(binding, call.name);
        // `pkg.mod.f()` after `import pkg.mod`.
        if (binding?.kind === 'module' || binding?.kind === 'external') {
          const target = this.resolveModule(file.path, scope, 0);
          if (target?.kind === 'file') return symbolIn(target.path, call.name, 0.9);
          if (target?.kind === 'external') return { id: target.module.id, confidence: 0.9, external: target.module };
        }
        // A class in this file: `Foo.create()`.
        const method = file.symbols.find((s) => s.qualifiedName === `${scope}.${call.name}`);
        if (method) return { id: method.id, confidence: 0.85 };
        return this.uniqueMethod(call.name);
      }
      case 'member':
        return this.uniqueMethod(call.name);
      default:
        return undefined;
    }
  }

  /** The receiver's type is unknown: only a method name that is unique in the repository is taken. */
  private uniqueMethod(name: string): { id: string; confidence: number } | undefined {
    const methods = this.methodsByName.get(name) ?? [];
    return name.length >= 4 && methods.length === 1 ? { id: methods[0]!.id, confidence: 0.5 } : undefined;
  }
}
