import { basename } from 'node:path';
import { setMeta, type XrayDb } from '../db/database.ts';
import { scanRepository } from './scan.ts';

export interface IndexStats {
  files: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  durationMs: number;
}

export function fileNodeId(path: string): string {
  return `file:${path}`;
}

/**
 * Incrementally syncs file nodes with the working tree. Files whose content_hash
 * is unchanged are left alone; changed or deleted files also lose their child
 * symbols and evidence so later parser passes can rebuild them.
 */
export function indexRepository(db: XrayDb, root: string): IndexStats {
  const started = performance.now();
  const { files, skipped } = scanRepository(root);

  const existing = new Map(
    (db.prepare("SELECT id, path, content_hash FROM nodes WHERE layer = 'file'").all() as {
      id: string;
      path: string;
      content_hash: string | null;
    }[]).map((row) => [row.id, row]),
  );

  const upsertFile = db.prepare(`
    INSERT INTO nodes (id, layer, type, name, path, language, content_hash, metadata)
    VALUES (@id, 'file', 'file', @name, @path, @language, @contentHash, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      language = excluded.language,
      content_hash = excluded.content_hash,
      metadata = excluded.metadata
  `);
  const deleteChildren = db.prepare('DELETE FROM nodes WHERE parent_id = ?');
  const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');
  const deleteEvidence = db.prepare('DELETE FROM evidence WHERE file_path = ?');

  const stats: IndexStats = { files: files.length, added: 0, updated: 0, unchanged: 0, removed: 0, skipped, durationMs: 0 };

  db.transaction(() => {
    for (const file of files) {
      const id = fileNodeId(file.path);
      const previous = existing.get(id);
      existing.delete(id);

      if (previous?.content_hash === file.contentHash) {
        stats.unchanged++;
        continue;
      }
      if (previous) {
        deleteChildren.run(id);
        deleteEvidence.run(file.path);
        stats.updated++;
      } else {
        stats.added++;
      }
      upsertFile.run({
        id,
        name: basename(file.path),
        path: file.path,
        language: file.language,
        contentHash: file.contentHash,
        metadata: JSON.stringify({ size: file.size }),
      });
    }

    // Anything left in `existing` is no longer on disk.
    for (const stale of existing.values()) {
      deleteNode.run(stale.id);
      deleteEvidence.run(stale.path);
      stats.removed++;
    }

    setMeta(db, { root, indexed_at: new Date().toISOString() });
  })();

  stats.durationMs = Math.round(performance.now() - started);
  return stats;
}
