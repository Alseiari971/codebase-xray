import { cppAdapter } from './cpp.ts';
import { pythonAdapter } from './python.ts';
import { loadTreeSitter } from './treesitter.ts';
import type { ParserAdapter } from './types.ts';
import { typescriptAdapter } from './typescript.ts';

/** Every language X-Ray reads. TypeScript/JavaScript use the type checker; C/C++ and Python use Tree-sitter. */
export const ADAPTERS: ParserAdapter[] = [typescriptAdapter, cppAdapter, pythonAdapter];

/** Loads the WebAssembly parsers the Tree-sitter adapters need. Call once before indexing. */
export function loadParsers(): Promise<void> {
  return loadTreeSitter();
}
