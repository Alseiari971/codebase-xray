// C and C++ adapter on Tree-sitter. There is no type checker, so includes that
// resolve next to the including file are deterministic, but every call is
// resolved by name and marked heuristic with a confidence: high when the name
// is the current class's, in the same file, or qualified; lower when it is only
// unique across the repository. Ambiguous calls are left out, not guessed.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { externalNodeId, fileNodeId } from '../graph/ids.ts';
import {
  evidenceFor,
  folderOf,
  lineRange,
  normalisePath,
  sharedFolders,
  SymbolTable,
  treeSitterReady,
  withTree,
  type RawCall,
  type SyntaxNode,
} from './treesitter.ts';
import type { ExternalModule, ExtractedEdge, ExtractedSymbol, FileExtraction, ParserAdapter } from './types.ts';

const LANGUAGES = new Set(['c', 'cpp']);
export const CPP_EXTENSIONS = /\.(c|h|cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+|inl|ipp|tpp)$/i;
const MAX_PARSE_BYTES = 1_000_000;
const MAX_EVIDENCE_PER_EDGE = 25;

interface RawInclude {
  spec: string;
  /** `"x.h"` (local) rather than `<x.h>`. */
  local: boolean;
  startLine: number;
  endLine: number;
}

interface ParsedFile {
  path: string;
  symbols: ExtractedSymbol[];
  includes: RawInclude[];
  calls: RawCall[];
  lines: string[];
}

type Located = ExtractedSymbol & { path: string };

export const cppAdapter: ParserAdapter = {
  name: 'tree-sitter-cpp',
  supports: (language) => LANGUAGES.has(language),
  ready: treeSitterReady,
  extract(root, paths, indexedPaths) {
    // Names resolve across the whole repository, so every C/C++ file is parsed;
    // only `paths` get edges back.
    const all = [...indexedPaths].filter((path) => CPP_EXTENSIONS.test(path)).sort();
    const parsed = new Map(all.map((path) => [path, parseFile(root, path)]));
    const context = new Resolver(parsed, indexedPaths);
    return paths.map((path) => context.extract(parsed.get(path) ?? emptyFile(path)));
  },
};

function emptyFile(path: string): ParsedFile {
  return { path, symbols: [], includes: [], calls: [], lines: [] };
}

function parseFile(root: string, path: string): ParsedFile {
  const absolute = join(root, path);
  if (statSync(absolute).size > MAX_PARSE_BYTES) return emptyFile(path);
  const source = readFileSync(absolute, 'utf8');
  return withTree('cpp', source, (tree) => {
    const table = new SymbolTable(path);
    const calls: RawCall[] = [];

    const collectCalls = (body: SyntaxNode | null, caller: string) => {
      if (!body) return;
      for (const site of body.descendantsOfType(['call_expression', 'new_expression'])) {
        if (!site) continue;
        const call = classifyCall(site, caller);
        if (call) calls.push(call);
      }
    };

    const addFunction = (node: SyntaxNode, scope: string[], owner?: ExtractedSymbol) => {
      const declarator = functionDeclarator(node.childForFieldName('declarator'));
      const nameNode = declarator?.childForFieldName('declarator');
      if (!nameNode) return;
      const parts = splitScope(nameNode.type === 'template_function' ? (nameNode.childForFieldName('name')?.text ?? '') : nameNode.text);
      const name = parts.at(-1);
      if (!name) return;
      const qualified = [...scope, ...parts].join('::');
      const isStatic = node.children.some((child) => child?.type === 'storage_class_specifier' && child.text === 'static');
      const symbol = table.add(node, owner || parts.length > 1 ? 'method' : 'function', name, qualified, { exported: !isStatic }, owner);
      collectCalls(node.childForFieldName('body'), symbol.id);
    };

    const addType = (node: SyntaxNode, scope: string[], owner?: ExtractedSymbol, nameOverride?: string) => {
      const body = node.childForFieldName('body');
      if (!body) return; // a forward declaration
      const name = nameOverride ?? (node.childForFieldName('name') ? splitScope(node.childForFieldName('name')!.text).at(-1) : undefined);
      if (!name) return; // anonymous
      const qualified = [...scope, name].join('::');
      if (node.type === 'enum_specifier') {
        table.add(node, 'enum', name, qualified, { exported: true }, owner);
        return;
      }
      const symbol = table.add(node, 'class', name, qualified, { kind: node.type.replace('_specifier', ''), exported: true }, owner);
      walk(body, [...scope, name], symbol);
    };

    const walk = (node: SyntaxNode, scope: string[], owner?: ExtractedSymbol) => {
      for (const child of node.namedChildren) {
        if (!child) continue;
        switch (child.type) {
          case 'function_definition':
            addFunction(child, scope, owner);
            break;
          case 'namespace_definition': {
            const name = child.childForFieldName('name')?.text;
            const body = child.childForFieldName('body');
            if (body) walk(body, name ? [...scope, ...splitScope(name)] : scope, owner);
            break;
          }
          case 'class_specifier':
          case 'struct_specifier':
          case 'union_specifier':
          case 'enum_specifier':
            addType(child, scope, owner);
            break;
          case 'declaration':
          case 'field_declaration':
          case 'type_definition': {
            // `struct Foo { ... };`, `typedef struct { ... } Foo;`
            const type = child.childForFieldName('type');
            if (type && /^(class|struct|union|enum)_specifier$/.test(type.type)) {
              const alias = child.type === 'type_definition' && !type.childForFieldName('name') ? child.childForFieldName('declarator')?.text : undefined;
              addType(type, scope, owner, alias);
            }
            break;
          }
          case 'linkage_specification': {
            const body = child.childForFieldName('body');
            if (body?.type === 'declaration_list') walk(body, scope, owner);
            else if (body) walk(child, scope, owner);
            break;
          }
          case 'template_declaration':
          case 'declaration_list':
          case 'field_declaration_list':
          case 'preproc_if':
          case 'preproc_ifdef':
          case 'preproc_else':
          case 'preproc_elif':
          case 'preproc_elifdef':
            walk(child, scope, owner);
            break;
        }
      }
    };

    walk(tree, []);
    const includes: RawInclude[] = [];
    for (const include of tree.descendantsOfType('preproc_include')) {
      const target = include?.childForFieldName('path');
      if (!include || !target) continue;
      const local = target.type === 'string_literal';
      const spec = target.text.replace(/^["<]|[">]$/g, '').trim();
      if (spec) includes.push({ spec, local, ...lineRange(include) });
    }
    return { path, symbols: table.symbols, includes, calls, lines: source.split(/\r?\n/) };
  });
}

/** Finds the function_declarator under pointer/reference/parenthesised declarators. */
function functionDeclarator(node: SyntaxNode | null): SyntaxNode | null {
  for (let current = node; current; current = current.childForFieldName('declarator')) {
    if (current.type === 'function_declarator') return current;
  }
  return null;
}

/** `ns::Foo<T>::bar` -> ['ns', 'Foo', 'bar']. */
function splitScope(text: string): string[] {
  let plain = text.replace(/\s+/g, '');
  for (let previous = ''; previous !== plain; ) {
    previous = plain;
    plain = plain.replace(/<[^<>]*>/g, '');
  }
  return plain.split('::').filter(Boolean);
}

function classifyCall(site: SyntaxNode, caller: string): RawCall | undefined {
  const start = site.startPosition.row + 1;
  if (site.type === 'new_expression') {
    const type = site.childForFieldName('type');
    const parts = type ? splitScope(type.text) : [];
    const name = parts.at(-1);
    return name ? { caller, kind: 'new', name, startLine: start, endLine: (type ?? site).endPosition.row + 1 } : undefined;
  }
  let fn = site.childForFieldName('function');
  if (!fn) return undefined;
  const endLine = fn.endPosition.row + 1;
  if (fn.type === 'template_function') fn = fn.childForFieldName('name') ?? fn;
  switch (fn.type) {
    case 'identifier':
      return { caller, kind: 'plain', name: fn.text, startLine: start, endLine };
    case 'qualified_identifier': {
      const parts = splitScope(fn.text);
      const name = parts.at(-1);
      return name ? { caller, kind: 'scoped', name, scope: parts.slice(0, -1).join('::'), startLine: start, endLine } : undefined;
    }
    case 'field_expression': {
      const field = fn.childForFieldName('field');
      const name = field ? splitScope(field.text).at(-1) : undefined;
      if (!name) return undefined;
      const self = fn.childForFieldName('argument')?.type === 'this';
      return { caller, kind: self ? 'self' : 'member', name, startLine: start, endLine };
    }
    default:
      return undefined;
  }
}

/** Standard C/C++ and common system headers: external, never "unresolved". */
const SYSTEM_HEADERS = new Set(
  (
    'algorithm any array atomic bit bitset cassert cctype cerrno cfloat charconv chrono cinttypes climits clocale cmath ' +
    'codecvt compare complex concepts condition_variable coroutine csetjmp csignal cstdarg cstddef cstdint cstdio cstdlib ' +
    'cstring ctime cwchar cwctype deque exception execution expected filesystem format forward_list fstream functional ' +
    'future initializer_list iomanip ios iosfwd iostream istream iterator latch limits list locale map memory memory_resource ' +
    'mutex new numbers numeric optional ostream print queue random ranges ratio regex scoped_allocator semaphore set ' +
    'shared_mutex source_location span sstream stack stdexcept stop_token streambuf string string_view syncstream ' +
    'system_error thread tuple type_traits typeindex typeinfo unordered_map unordered_set utility valarray variant vector ' +
    'version assert.h complex.h ctype.h errno.h fenv.h float.h inttypes.h iso646.h limits.h locale.h math.h setjmp.h ' +
    'signal.h stdalign.h stdarg.h stdatomic.h stdbool.h stddef.h stdint.h stdio.h stdlib.h stdnoreturn.h string.h tgmath.h ' +
    'threads.h time.h uchar.h wchar.h wctype.h unistd.h fcntl.h pthread.h dlfcn.h dirent.h poll.h sched.h semaphore.h ' +
    'termios.h windows.h winsock2.h ws2tcpip.h intrin.h immintrin.h emmintrin.h xmmintrin.h'
  ).split(' '),
);

class Resolver {
  private readonly byName = new Map<string, Located[]>();
  private readonly byBasename = new Map<string, string[]>();
  private readonly byStem = new Map<string, string[]>();

  constructor(
    private readonly files: Map<string, ParsedFile>,
    private readonly indexedPaths: ReadonlySet<string>,
  ) {
    for (const file of files.values()) {
      for (const symbol of file.symbols) {
        const list = this.byName.get(symbol.name) ?? [];
        list.push({ ...symbol, path: file.path });
        this.byName.set(symbol.name, list);
      }
    }
    for (const path of indexedPaths) {
      const base = path.slice(path.lastIndexOf('/') + 1);
      this.byBasename.set(base, [...(this.byBasename.get(base) ?? []), path]);
      if (CPP_EXTENSIONS.test(path)) {
        const stem = path.replace(/\.[^./]+$/, '');
        this.byStem.set(stem, [...(this.byStem.get(stem) ?? []), path]);
      }
    }
  }

  extract(file: ParsedFile): FileExtraction {
    const fileId = fileNodeId(file.path);
    const edges = new EdgeSet();
    const externals = new Map<string, ExternalModule>();
    const unresolved = new Set<string>();
    const visible = new Set([file.path, ...this.siblings(file.path)]);

    for (const include of file.includes) {
      const evidence = [evidenceFor(file.lines, include.startLine, include.endLine, 'tree-sitter-cpp:include')];
      const resolved = this.resolveInclude(file.path, include);
      if (resolved.kind === 'file') {
        visible.add(resolved.path);
        for (const sibling of this.siblings(resolved.path)) visible.add(sibling);
        if (resolved.path === file.path) continue;
        edges.add({ source: fileId, target: fileNodeId(resolved.path), relation: 'imports', resolutionType: resolved.confidence === 1 ? 'deterministic' : 'heuristic', confidence: resolved.confidence, metadata: { include: include.spec }, evidence });
      } else if (resolved.kind === 'external') {
        externals.set(resolved.module.id, resolved.module);
        edges.add({ source: fileId, target: resolved.module.id, relation: 'imports', resolutionType: 'deterministic', confidence: 1, metadata: { include: include.spec }, evidence });
      } else {
        unresolved.add(include.spec);
      }
    }

    const callerClass = new Map(file.symbols.filter((s) => s.type === 'method').map((s) => [s.id, s.qualifiedName.split('::').slice(0, -1).join('::')]));
    for (const call of file.calls) {
      const target = this.resolveCall(call, file.path, callerClass.get(call.caller), visible);
      if (!target || target.symbol.id === call.caller) continue;
      edges.add({
        source: call.caller,
        target: target.symbol.id,
        relation: 'calls',
        resolutionType: 'heuristic',
        confidence: target.confidence,
        metadata: { via: call.kind },
        evidence: [evidenceFor(file.lines, call.startLine, call.endLine, `tree-sitter-cpp:${call.kind === 'new' ? 'new-expression' : 'call-expression'}`)],
      });
    }

    return { path: file.path, symbols: file.symbols, edges: edges.values(), externals: [...externals.values()], unresolvedImports: [...unresolved].sort() };
  }

  /** foo.h <-> foo.cpp: a header's declarations are usually defined in its implementation file. */
  private siblings(path: string): string[] {
    return this.byStem.get(path.replace(/\.[^./]+$/, '')) ?? [];
  }

  private resolveInclude(from: string, include: RawInclude):
    | { kind: 'file'; path: string; confidence: number }
    | { kind: 'external'; module: ExternalModule }
    | { kind: 'unresolved' } {
    if (include.local) {
      const beside = normalisePath(`${folderOf(from)}/${include.spec}`);
      if (beside && this.indexedPaths.has(beside)) return { kind: 'file', path: beside, confidence: 1 };
    }
    // Include paths are not known, so match by suffix and prefer the nearest file.
    const base = include.spec.slice(include.spec.lastIndexOf('/') + 1);
    const candidates = (this.byBasename.get(base) ?? []).filter((path) => path === include.spec || path.endsWith(`/${include.spec}`));
    if (candidates.length > 0) {
      const best = [...candidates].sort((a, b) => sharedFolders(b, from) - sharedFolders(a, from) || a.length - b.length || a.localeCompare(b))[0]!;
      return { kind: 'file', path: best, confidence: candidates.length === 1 ? 0.9 : 0.7 };
    }
    if (include.local && !SYSTEM_HEADERS.has(include.spec)) return { kind: 'unresolved' };
    if (SYSTEM_HEADERS.has(include.spec) || /^(sys|arpa|netinet|bits|linux|mach)\//.test(include.spec)) {
      return { kind: 'external', module: { id: externalNodeId(`std:${include.spec}`), type: 'builtin', name: `<${include.spec}>` } };
    }
    const library = include.spec.split('/')[0]!.replace(/\.[^.]+$/, '');
    return { kind: 'external', module: { id: externalNodeId(`lib:${library}`), type: 'package', name: library } };
  }

  private resolveCall(call: RawCall, path: string, callerClass: string | undefined, visible: Set<string>): { symbol: Located; confidence: number } | undefined {
    const candidates = this.byName.get(call.name) ?? [];
    if (candidates.length === 0) return undefined;
    const unique = (list: Located[]) => (list.length === 1 ? list[0] : undefined);
    const pick = (list: Located[], nearby: number, anywhere: number) => {
      const near = unique(list.filter((s) => visible.has(s.path)));
      if (near) return { symbol: near, confidence: nearby };
      const only = unique(list);
      return only ? { symbol: only, confidence: anywhere } : undefined;
    };
    const ofClass = (owner: string) => candidates.filter((s) => s.qualifiedName === `${owner}::${call.name}` || s.qualifiedName.endsWith(`::${owner}::${call.name}`));

    switch (call.kind) {
      case 'self':
        return callerClass ? pick(ofClass(callerClass), 0.85, 0.8) : undefined;
      case 'scoped':
        return call.scope ? pick(ofClass(call.scope), 0.85, 0.8) : undefined;
      case 'new':
        return pick(candidates.filter((s) => s.type === 'class'), 0.85, 0.6);
      case 'member':
        // The receiver's type is unknown: only a method name that is unique is taken.
        return call.name.length >= 4 ? pick(candidates.filter((s) => s.type === 'method'), 0.6, 0.5) : undefined;
      case 'plain': {
        if (callerClass) {
          const own = pick(ofClass(callerClass), 0.85, 0.8);
          if (own) return own;
        }
        const sameFile = unique(candidates.filter((s) => s.path === path && s.type !== 'method'));
        if (sameFile) return { symbol: sameFile, confidence: 0.9 };
        return pick(candidates.filter((s) => s.type !== 'method'), 0.8, 0.6);
      }
    }
  }
}

/** One edge per (source, target, relation), with up to 25 pieces of evidence. */
export class EdgeSet {
  private readonly edges = new Map<string, ExtractedEdge>();

  add(edge: ExtractedEdge): void {
    const key = `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
    const existing = this.edges.get(key);
    if (!existing) {
      this.edges.set(key, edge);
      return;
    }
    existing.confidence = Math.max(existing.confidence, edge.confidence);
    if (edge.resolutionType === 'deterministic') existing.resolutionType = 'deterministic';
    if (existing.evidence.length < MAX_EVIDENCE_PER_EDGE) existing.evidence.push(...edge.evidence);
  }

  values(): ExtractedEdge[] {
    return [...this.edges.values()];
  }
}
