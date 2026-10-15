import ignore, { type Ignore } from 'ignore';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface ScannedFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  absPath: string;
  language: string;
  contentHash: string;
  size: number;
}

export interface ScanResult {
  files: ScannedFile[];
  /** Files that were not ignored but have no recognised language. */
  skipped: number;
}

// Skipped even without a .gitignore: VCS data, dependencies, our own index,
// and framework build output that would flood the graph with generated code.
const ALWAYS_IGNORED = [
  '.git/', 'node_modules/', '.xray/',
  '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.vercel/', 'coverage/',
  '*.min.js', '*.min.css',
  // Vendored dependencies, and Python and CMake build output.
  '3rdparty/', 'third_party/', 'thirdparty/', 'vendor/',
  '__pycache__/', '.venv/', 'venv/', '.tox/', '.mypy_cache/', '.pytest_cache/', 'cmake-build-*/',
];

/** Ignore rules from one .gitignore; patterns are relative to `base`. */
interface IgnoreScope {
  base: string;
  ig: Ignore;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
  '.c': 'c', '.h': 'cpp',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.h++': 'cpp', '.inl': 'cpp', '.ipp': 'cpp', '.tpp': 'cpp',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.sql': 'sql',
  '.prisma': 'prisma',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.html': 'html',
  '.css': 'css', '.scss': 'scss',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.sh': 'shell',
};

export function detectLanguage(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

/**
 * Walks a repository and hashes every source file, honouring .gitignore files
 * at every level. A nested .gitignore cannot re-include (`!pattern`) a path
 * that a parent .gitignore excluded.
 */
export function scanRepository(root: string): ScanResult {
  const result: ScanResult = { files: [], skipped: 0 };
  walk(root, '', [{ base: '', ig: ignore().add(ALWAYS_IGNORED) }], result);
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function walk(root: string, relDir: string, parentScopes: IgnoreScope[], result: ScanResult): void {
  const scopes = withGitignore(root, relDir, parentScopes);

  for (const entry of readdirSync(join(root, relDir), { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (!isIgnored(scopes, `${rel}/`)) walk(root, rel, scopes, result);
      continue;
    }
    // Symlinks and special files are skipped so the walk cannot escape the repo.
    if (!entry.isFile() || isIgnored(scopes, rel)) continue;

    const language = detectLanguage(rel);
    if (!language) {
      result.skipped++;
      continue;
    }

    const absPath = join(root, rel);
    const content = readFileSync(absPath);
    result.files.push({
      path: rel,
      absPath,
      language,
      contentHash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    });
  }
}

function withGitignore(root: string, relDir: string, scopes: IgnoreScope[]): IgnoreScope[] {
  const gitignore = join(root, relDir, '.gitignore');
  if (!existsSync(gitignore)) return scopes;
  return [...scopes, { base: relDir, ig: ignore().add(readFileSync(gitignore, 'utf8')) }];
}

function isIgnored(scopes: IgnoreScope[], rel: string): boolean {
  return scopes.some(({ base, ig }) => ig.ignores(base ? rel.slice(base.length + 1) : rel));
}
