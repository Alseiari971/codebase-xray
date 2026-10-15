// Language-neutral intermediate representation produced by parser adapters
// (blueprint section 9). Adapters only describe what they found; the indexer
// owns ids for files and clusters, and all database writes.

export type ResolutionType = 'deterministic' | 'heuristic' | 'runtime_observed' | 'ai_inferred';

export interface ExtractedSymbol {
  id: string;
  /** Parent symbol id for members; undefined means the symbol belongs to the file. */
  parentId?: string;
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable';
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  metadata: Record<string, unknown>;
}

export interface ExtractedEvidence {
  startLine: number;
  endLine: number;
  /** Parser rule that produced it, e.g. `ts-morph:import-declaration`. */
  rule: string;
  excerptHash: string;
}

export interface ExtractedEdge {
  source: string;
  target: string;
  relation: 'imports' | 'calls';
  resolutionType: ResolutionType;
  confidence: number;
  metadata: Record<string, unknown>;
  evidence: ExtractedEvidence[];
}

export interface ExternalModule {
  id: string;
  type: 'package' | 'builtin';
  name: string;
}

export interface FileExtraction {
  path: string;
  /** Parents always come before their members. */
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  externals: ExternalModule[];
  /** Relative or aliased specifiers that did not resolve to an indexed file. */
  unresolvedImports: string[];
}

export interface ParserAdapter {
  readonly name: string;
  supports(language: string): boolean;
  /**
   * Extracts symbols and edges for `paths`. `indexedPaths` is every file in the
   * index, so edges can point at files and symbols outside `paths`.
   */
  extract(root: string, paths: string[], indexedPaths: ReadonlySet<string>): FileExtraction[];
}
