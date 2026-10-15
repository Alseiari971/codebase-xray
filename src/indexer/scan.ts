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

const ALWAYS_IGNORED = ['.git/', 'node_modules/', '.xray/'];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
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
 * Walks a repository and hashes every source file, honouring the root .gitignore.
 * Nested .gitignore files are not yet supported.
 */
export function scanRepository(root: string): ScanResult {
  const ig = ignore().add(ALWAYS_IGNORED);
  const gitignore = join(root, '.gitignore');
  if (existsSync(gitignore)) ig.add(readFileSync(gitignore, 'utf8'));

  const result: ScanResult = { files: [], skipped: 0 };
  walk(root, '', ig, result);
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function walk(root: string, relDir: string, ig: Ignore, result: ScanResult): void {
  for (const entry of readdirSync(join(root, relDir), { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (!ig.ignores(`${rel}/`)) walk(root, rel, ig, result);
      continue;
    }
    // Symlinks and special files are skipped so the walk cannot escape the repo.
    if (!entry.isFile() || ig.ignores(rel)) continue;

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
