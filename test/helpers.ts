import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-app');

const tempDirs: string[] = [];
// Cleaned up when the test process exits: an after() registered from inside a
// before() hook would run as soon as that hook finished.
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

/** Creates a throwaway repository from a { relativePath: contents } map. */
export function makeRepo(files: Record<string, string>): string {
  const root = tempDir('xray-test-');
  writeFiles(root, files);
  return root;
}

/** A writable copy of the sample-app fixture, plus a .gitignore'd file that cannot be committed. */
export function copyFixture(): string {
  const root = tempDir('xray-fixture-');
  cpSync(FIXTURE, root, { recursive: true });
  writeFiles(root, { 'generated/schema.ts': 'export const ignored = true;\n' });
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
}

/** Runs git in `root` with a fixed identity, so commits work on any machine. */
export function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=xray-test', '-c', 'user.email=xray@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
