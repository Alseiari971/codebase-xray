import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Node, Project, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import { externalNodeId, fileNodeId, symbolNodeId } from '../graph/ids.ts';
import type {
  ExternalModule,
  ExtractedEdge,
  ExtractedEvidence,
  ExtractedSymbol,
  FileExtraction,
  ParserAdapter,
  ResolutionType,
} from './types.ts';

/** Files larger than this are almost always bundles or generated code. */
const MAX_PARSE_BYTES = 1_000_000;
const MAX_EVIDENCE_PER_EDGE = 25;
/** A call through an interface member: we know the contract, not which implementation runs. */
const INTERFACE_MEMBER_CONFIDENCE = 0.7;

const LANGUAGES = new Set(['typescript', 'javascript']);

export const typescriptAdapter: ParserAdapter = {
  name: 'ts-morph',
  supports: (language) => LANGUAGES.has(language),
  extract(root, paths, indexedPaths) {
    const project = createProject(root);
    const tooLarge = paths.filter((path) => statSync(join(root, path)).size > MAX_PARSE_BYTES);
    const sourceFiles = paths
      .filter((path) => !tooLarge.includes(path))
      .map((path) => project.addSourceFileAtPath(join(root, path)));
    // Pull in everything the roots import so the type checker can follow
    // references into files that are not being re-extracted this run.
    project.resolveSourceFileDependencies();

    const context = new ExtractionContext(root, project, indexedPaths);
    return [
      ...sourceFiles.map((sourceFile) => context.extractFile(sourceFile)),
      // Still reported, so symbols from before the file grew are cleared.
      ...tooLarge.map((path) => ({ path, symbols: [], edges: [], externals: [], unresolvedImports: [] })),
    ];
  },
};

function createProject(root: string): Project {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const tsConfigFilePath = join(root, name);
    if (!existsSync(tsConfigFilePath)) continue;
    try {
      const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
      project.compilerOptions.set({ allowJs: true, noEmit: true });
      return project;
    } catch {
      // An unreadable config should not block indexing; fall back to defaults.
      break;
    }
  }
  return new Project({
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      noEmit: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
}

interface SymbolTable {
  symbols: ExtractedSymbol[];
  byNode: Map<ts.Node, ExtractedSymbol>;
}

type ResolvedModule =
  | { kind: 'file'; path: string }
  | { kind: 'external'; module: ExternalModule }
  | { kind: 'asset' }
  | { kind: 'unresolved' };

interface CallTarget {
  target: string;
  resolutionType: ResolutionType;
  confidence: number;
  member?: string;
  external?: ExternalModule;
}

class ExtractionContext {
  private readonly symbolTables = new Map<SourceFile, SymbolTable>();
  private readonly moduleCache = new Map<string, ResolvedModule>();
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly host: ts.ModuleResolutionHost;

  constructor(
    private readonly root: string,
    project: Project,
    private readonly indexedPaths: ReadonlySet<string>,
  ) {
    this.compilerOptions = project.getCompilerOptions();
    this.host = project.getModuleResolutionHost();
  }

  extractFile(sourceFile: SourceFile): FileExtraction {
    const path = this.repoPath(sourceFile.getFilePath())!;
    const fileId = fileNodeId(path);
    const table = this.symbolTable(sourceFile);
    const lines = sourceFile.getFullText().split(/\r?\n/);
    const edges = new EdgeCollector();
    const externals = new Map<string, ExternalModule>();
    const unresolvedImports = new Set<string>();

    const addImport = (specifier: string, node: Node, rule: string, metadata: Record<string, unknown>) => {
      const resolved = this.resolveModule(specifier, sourceFile);
      if (resolved.kind === 'unresolved') unresolvedImports.add(specifier);
      if (resolved.kind === 'unresolved' || resolved.kind === 'asset') return;
      const target = resolved.kind === 'file' ? fileNodeId(resolved.path) : resolved.module.id;
      if (resolved.kind === 'external') externals.set(resolved.module.id, resolved.module);
      if (target === fileId) return;
      edges.add({
        source: fileId,
        target,
        relation: 'imports',
        resolutionType: 'deterministic',
        confidence: 1,
        metadata,
        evidence: [evidence(node, node, rule, lines)],
      });
    };

    for (const declaration of sourceFile.getImportDeclarations()) {
      addImport(declaration.getModuleSpecifierValue(), declaration, 'ts-morph:import-declaration', {
        typeOnly: declaration.isTypeOnly(),
      });
    }
    for (const declaration of sourceFile.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier) {
        addImport(specifier, declaration, 'ts-morph:export-from', { typeOnly: declaration.isTypeOnly(), reexport: true });
      }
    }

    const addCall = (site: Node, calleeExpression: Node, rule: string, metadata: Record<string, unknown> = {}) => {
      const callee = this.resolveCallTarget(calleeExpression);
      if (!callee) return;
      const source = callerId(site, table, fileId);
      if (callee.target === source) return; // recursion adds noise, not insight
      if (callee.external) externals.set(callee.external.id, callee.external);
      edges.add({
        source,
        target: callee.target,
        relation: 'calls',
        resolutionType: callee.resolutionType,
        confidence: callee.confidence,
        metadata: callee.member ? { ...metadata, members: [callee.member] } : metadata,
        evidence: [evidence(site, calleeExpression, rule, lines)],
      });
    };

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      const specifier = stringArgument(call.getArguments()[0]);
      if (expression.getKind() === SyntaxKind.ImportKeyword && specifier !== undefined) {
        addImport(specifier, call, 'ts-morph:dynamic-import', { typeOnly: false, dynamic: true });
      } else if (Node.isIdentifier(expression) && expression.getText() === 'require' && specifier !== undefined) {
        addImport(specifier, call, 'ts-morph:require', { typeOnly: false });
      } else {
        addCall(call, expression, 'ts-morph:call-expression');
      }
    }
    // Constructing a class depends on it just like calling a function does.
    for (const construction of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      addCall(construction, construction.getExpression(), 'ts-morph:new-expression', { construct: true });
    }
    // Rendering a component is how React code "calls" it.
    for (const element of [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ]) {
      addCall(element, element.getTagNameNode(), 'ts-morph:jsx-element', { jsx: true });
    }

    return {
      path,
      symbols: table.symbols,
      edges: edges.values(),
      externals: [...externals.values()],
      unresolvedImports: [...unresolvedImports].sort(),
    };
  }

  /** Top-level declarations and class members. Deterministic for a given file. */
  private symbolTable(sourceFile: SourceFile): SymbolTable {
    const cached = this.symbolTables.get(sourceFile);
    if (cached) return cached;

    const path = this.repoPath(sourceFile.getFilePath())!;
    const table: SymbolTable = { symbols: [], byNode: new Map() };
    const usedIds = new Set<string>();

    const add = (
      node: Node,
      range: Node,
      type: ExtractedSymbol['type'],
      name: string,
      metadata: Record<string, unknown>,
      parent?: ExtractedSymbol,
    ): ExtractedSymbol => {
      const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
      let id = symbolNodeId(path, qualifiedName);
      // Declaration merging or redeclaration; disambiguate by line.
      if (usedIds.has(id)) id = symbolNodeId(path, `${qualifiedName}@${range.getStartLineNumber()}`);
      usedIds.add(id);
      const symbol: ExtractedSymbol = {
        id,
        parentId: parent?.id,
        type,
        name,
        qualifiedName,
        startLine: range.getStartLineNumber(),
        endLine: range.getEndLineNumber(),
        metadata,
      };
      table.symbols.push(symbol);
      table.byNode.set(node.compilerNode, symbol);
      return symbol;
    };

    for (const fn of sourceFile.getFunctions()) {
      if (fn.isOverload()) continue;
      add(fn, fn, 'function', fn.getName() ?? 'default', { exported: fn.isExported(), async: fn.isAsync() });
    }

    for (const cls of sourceFile.getClasses()) {
      const owner = add(cls, cls, 'class', cls.getName() ?? 'default', { exported: cls.isExported() });
      for (const method of cls.getMethods()) {
        if (method.isOverload()) continue;
        add(method, method, 'method', method.getName(), { static: method.isStatic(), async: method.isAsync() }, owner);
      }
      for (const property of cls.getProperties()) {
        if (isFunctionLike(property.getInitializer())) {
          add(property, property, 'method', property.getName(), { static: property.isStatic() }, owner);
        }
      }
    }

    for (const iface of sourceFile.getInterfaces()) {
      add(iface, iface, 'interface', iface.getName(), { exported: iface.isExported() });
    }
    for (const alias of sourceFile.getTypeAliases()) {
      add(alias, alias, 'type', alias.getName(), { exported: alias.isExported() });
    }
    for (const enumDeclaration of sourceFile.getEnums()) {
      add(enumDeclaration, enumDeclaration, 'enum', enumDeclaration.getName(), { exported: enumDeclaration.isExported() });
    }

    for (const statement of sourceFile.getVariableStatements()) {
      const exported = statement.isExported();
      const declarations = statement.getDeclarations();
      for (const declaration of declarations) {
        if (!Node.isIdentifier(declaration.getNameNode())) continue;
        const range = declarations.length === 1 ? statement : declaration;
        const initializer = declaration.getInitializer();
        if (isFunctionLike(initializer)) {
          add(declaration, range, 'function', declaration.getName(), { exported, async: initializer.isAsync() });
        } else if (exported) {
          add(declaration, range, 'variable', declaration.getName(), { exported });
        }
      }
    }

    for (const assignment of sourceFile.getExportAssignments()) {
      if (!assignment.isExportEquals() && isFunctionLike(assignment.getExpression())) {
        add(assignment, assignment, 'function', 'default', { exported: true });
      }
    }

    this.symbolTables.set(sourceFile, table);
    return table;
  }

  private resolveCallTarget(expression: Node): CallTarget | undefined {
    const nameNode = Node.isPropertyAccessExpression(expression) ? expression.getNameNode() : expression;
    const symbol = nameNode.getSymbol();
    if (symbol) {
      const target = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
      for (const declaration of target.getDeclarations()) {
        const hit = this.symbolForDeclaration(declaration);
        if (hit) return hit;
      }
    }
    return this.externalCallTarget(expression);
  }

  private symbolForDeclaration(declaration: Node): CallTarget | undefined {
    const sourceFile = declaration.getSourceFile();
    const path = this.repoPath(sourceFile.getFilePath());
    if (!path || !this.indexedPaths.has(path)) return undefined;

    const table = this.symbolTable(sourceFile);
    const direct = table.byNode.get(declaration.compilerNode);
    if (direct) return { target: direct.id, resolutionType: 'deterministic', confidence: 1 };

    if (Node.isMethodSignature(declaration) || Node.isPropertySignature(declaration)) {
      for (let node: Node | undefined = declaration.getParent(); node; node = node.getParent()) {
        const owner = table.byNode.get(node.compilerNode);
        if (owner?.type === 'interface' || owner?.type === 'type') {
          return {
            target: owner.id,
            resolutionType: 'heuristic',
            confidence: INTERFACE_MEMBER_CONFIDENCE,
            member: declaration.getName(),
          };
        }
      }
    }
    return undefined;
  }

  /** `bcrypt.hash()` or `express()`: a call through a binding imported from a package. */
  private externalCallTarget(expression: Node): CallTarget | undefined {
    let root = expression;
    while (Node.isPropertyAccessExpression(root) || Node.isElementAccessExpression(root)) root = root.getExpression();
    if (!Node.isIdentifier(root)) return undefined;

    for (const declaration of root.getSymbol()?.getDeclarations() ?? []) {
      const specifier = importSpecifierOf(declaration);
      if (specifier === undefined) continue;
      const resolved = this.resolveModule(specifier, declaration.getSourceFile());
      if (resolved.kind !== 'external') return undefined;
      return {
        target: resolved.module.id,
        resolutionType: 'deterministic',
        confidence: 1,
        member: Node.isPropertyAccessExpression(expression) ? expression.getName() : root.getText(),
        external: resolved.module,
      };
    }
    return undefined;
  }

  private resolveModule(specifier: string, from: SourceFile): ResolvedModule {
    const key = `${from.getDirectoryPath()}\0${specifier}`;
    let resolved = this.moduleCache.get(key);
    if (!resolved) {
      resolved = this.resolveModuleUncached(specifier, from.getFilePath());
      this.moduleCache.set(key, resolved);
    }
    return resolved;
  }

  private resolveModuleUncached(specifier: string, containingFile: string): ResolvedModule {
    if (isBuiltin(specifier)) {
      const name = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
      return { kind: 'external', module: { id: externalNodeId(name), type: 'builtin', name } };
    }

    const result = ts.resolveModuleName(specifier, containingFile, this.compilerOptions, this.host).resolvedModule;
    if (result && !result.isExternalLibraryImport) {
      const path = this.repoPath(result.resolvedFileName);
      if (path && this.indexedPaths.has(path)) return { kind: 'file', path };
    }

    if (specifier.startsWith('.')) {
      // TypeScript only resolves code; `import './styles.css'` is resolved literally.
      const literal = resolve(dirname(containingFile), specifier);
      const path = this.repoPath(literal);
      if (path && this.indexedPaths.has(path)) return { kind: 'file', path };
      // Fonts, images and other files we do not index are assets, not missing imports.
      if (existsSync(literal)) return { kind: 'asset' };
    }

    // Packages count even when node_modules is not installed: the specifier
    // itself names the dependency.
    const pkg = packageName(specifier);
    if (pkg) return { kind: 'external', module: { id: externalNodeId(`npm:${pkg}`), type: 'package', name: pkg } };
    return { kind: 'unresolved' };
  }

  private repoPath(absolutePath: string): string | undefined {
    const rel = relative(this.root, absolutePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return rel.split(sep).join('/');
  }
}

/** Merges repeated edges (e.g. many call sites) into one edge with several pieces of evidence. */
class EdgeCollector {
  private readonly edges = new Map<string, ExtractedEdge>();

  add(edge: ExtractedEdge): void {
    const key = `${edge.source}\0${edge.relation}\0${edge.target}`;
    const existing = this.edges.get(key);
    if (!existing) {
      this.edges.set(key, edge);
      return;
    }
    existing.confidence = Math.max(existing.confidence, edge.confidence);
    if (edge.resolutionType === 'deterministic') existing.resolutionType = 'deterministic';
    for (const [field, value] of Object.entries(edge.metadata)) {
      const current = existing.metadata[field];
      if (typeof value === 'boolean' && typeof current === 'boolean') {
        existing.metadata[field] = current && value; // e.g. typeOnly only if every import is
      } else if (Array.isArray(value) && Array.isArray(current)) {
        existing.metadata[field] = [...new Set([...current, ...value])];
      }
    }
    if (existing.evidence.length < MAX_EVIDENCE_PER_EDGE) existing.evidence.push(...edge.evidence);
  }

  values(): ExtractedEdge[] {
    return [...this.edges.values()];
  }
}

function callerId(site: Node, table: SymbolTable, fileId: string): string {
  for (let node: Node | undefined = site.getParent(); node; node = node.getParent()) {
    const symbol = table.byNode.get(node.compilerNode);
    if (symbol) return symbol.id;
  }
  return fileId; // module top level
}

/** Evidence runs from the start of `site` to the end of `until`, so a call cites `foo(` rather than its whole callback. */
function evidence(site: Node, until: Node, rule: string, lines: string[]): ExtractedEvidence {
  const startLine = site.getStartLineNumber();
  const endLine = Math.max(startLine, until.getEndLineNumber());
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  return { startLine, endLine, rule, excerptHash: createHash('sha256').update(excerpt).digest('hex') };
}

function isFunctionLike(node: Node | undefined): node is Node & { isAsync(): boolean } {
  return node !== undefined && (Node.isArrowFunction(node) || Node.isFunctionExpression(node));
}

function stringArgument(node: Node | undefined): string | undefined {
  if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return node.getLiteralValue();
  return undefined;
}

/** The module specifier an identifier was bound from, via `import` or `require()`. */
function importSpecifierOf(declaration: Node): string | undefined {
  const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (importDeclaration) return importDeclaration.getModuleSpecifierValue();

  const variable = Node.isVariableDeclaration(declaration)
    ? declaration
    : declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const initializer = variable?.getInitializer();
  if (initializer && Node.isCallExpression(initializer)) {
    const callee = initializer.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === 'require') return stringArgument(initializer.getArguments()[0]);
  }
  return undefined;
}

const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/** `lodash/fp` -> `lodash`, `@scope/pkg/sub` -> `@scope/pkg`; undefined for relative paths and aliases like `@/x`. */
export function packageName(specifier: string): string | undefined {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return name && PACKAGE_NAME.test(name) ? name : undefined;
}
