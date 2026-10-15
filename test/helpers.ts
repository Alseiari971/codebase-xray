import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';

/** Creates a throwaway repository from a { relativePath: contents } map. */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'xray-test-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  writeFiles(root, files);
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
}
