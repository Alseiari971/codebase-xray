import type { XrayDb } from '../db/database.ts';
import { externalNodeId, fileNodeId } from './ids.ts';

export class TargetError extends Error {}

/**
 * Finds a node from what a person or an agent would type: a node id, a
 * repository file path, a symbol name (`login`, `UserRepository.findByEmail`),
 * or a package name (`bcrypt`, `fs`).
 */
export function resolveTarget(db: XrayDb, target: string): string {
  const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').pluck();
  if (exists.get(target)) return target;
  const path = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (exists.get(fileNodeId(path))) return fileNodeId(path);
  const symbols = db
    .prepare("SELECT id FROM nodes WHERE layer = 'symbol' AND (symbol = ? OR name = ?) ORDER BY id LIMIT 9")
    .pluck()
    .all(target, target) as string[];
  if (symbols.length === 1) return symbols[0]!;
  if (symbols.length > 1) {
    throw new TargetError(`"${target}" matches several symbols; pass one of these ids:\n  ${symbols.slice(0, 8).join('\n  ')}`);
  }
  // Packages and builtins by name: `bcrypt`, `@scope/pkg`, `fs` or `node:fs`.
  for (const id of [externalNodeId(`npm:${target}`), externalNodeId(target.startsWith('node:') ? target : `node:${target}`)]) {
    if (exists.get(id)) return id;
  }
  throw new TargetError(`No file, symbol, package or node named "${target}" in the index`);
}
