import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FileExtraction } from '../adapters/types.ts';
import { ADAPTERS } from '../adapters/index.ts';
import { getMeta, setMeta, type XrayDb } from '../db/database.ts';
import { fileNodeId } from '../graph/ids.ts';
import { clusterFiles } from './cluster.ts';
import { scanRepository, type ScannedFile } from './scan.ts';

export { fileNodeId };

/** Bump whenever adapter output changes, so existing indexes are rebuilt rather than mixed. */
export const EXTRACTOR_VERSION = '2'; // 2: C/C++ and Python adapters

/** Changes to these files can change how every import resolves. */
const PROJECT_CONFIG_FILES = ['tsconfig.json', 'jsconfig.json', 'package.json'];


export interface IndexOptions {
  /** Re-extract every file even if nothing changed. */
  full?: boolean;
}

export interface IndexStats {
  files: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  /** Files whose symbols and edges were (re)extracted this run. */
  parsed: number;
  symbols: number;
  imports: number;
  calls: number;
  externals: number;
  clusters: number;
  unresolvedImports: number;
  durationMs: number;
}

/**
 * Brings the evidence graph in line with the working tree.
 *
 * Only files that changed, plus files with edges into them, are re-extracted.
 * The adapter still sees the whole project so cross-file references resolve,
 * and symbol ids are deterministic, so edges from untouched files stay valid.
 */
export function indexRepository(db: XrayDb, root: string, options: IndexOptions = {}): IndexStats {
  const started = performance.now();
  const { files, skipped } = scanRepository(root);
  const configHash = hashProjectConfig(root);
  const fullRebuild =
    options.full === true ||
    getMeta(db, 'extractor_version') !== EXTRACTOR_VERSION ||
    getMeta(db, 'config_hash') !== configHash;

  const sync = planFileSync(db, files);
  const dirty = fullRebuild ? files.map((file) => file.path) : sync.dirty;

  const languageOf = new Map(files.map((file) => [file.path, file.language]));
  const indexedPaths = new Set(languageOf.keys());
  const extractions: FileExtraction[] = [];
  for (const adapter of ADAPTERS) {
    const paths = dirty.filter((path) => adapter.supports(languageOf.get(path) ?? '')).sort();
    if (paths.length === 0) continue;
    if (adapter.ready && !adapter.ready()) {
      throw new Error(`The ${adapter.name} parser is not loaded: await loadParsers() before indexing.`);
    }
    extractions.push(...adapter.extract(root, paths, indexedPaths));
  }

  // One transaction: if extraction or writing fails, file hashes are not
  // updated either, so the next run retries the same files.
  db.transaction(() => {
    sync.apply();
    writeExtractions(db, extractions, languageOf);
    writeClusters(db, files);
    // Packages nobody imports or calls any more.
    db.prepare("DELETE FROM nodes WHERE layer = 'external' AND id NOT IN (SELECT target FROM edges)").run();
    setMeta(db, {
      root,
      indexed_at: new Date().toISOString(),
      extractor_version: EXTRACTOR_VERSION,
      config_hash: configHash,
    });
  })();

  return {
    files: files.length,
    ...sync.counts,
    skipped,
    parsed: extractions.length,
    ...graphCounts(db),
    durationMs: Math.round(performance.now() - started),
  };
}

interface FileSyncPlan {
  counts: { added: number; updated: number; unchanged: number; removed: number };
  /** Changed files plus the files whose edges point into them. */
  dirty: string[];
  /** Writes the file nodes; call inside the indexing transaction. */
  apply: () => void;
}

/** Compares the scan with stored content_hashes and works out which files need re-extraction. */
function planFileSync(db: XrayDb, files: ScannedFile[]): FileSyncPlan {
  const existing = new Map(
    (db.prepare("SELECT path, content_hash FROM nodes WHERE layer = 'file'").all() as {
      path: string;
      content_hash: string | null;
    }[]).map((row) => [row.path, row.content_hash]),
  );

  const added = files.filter((file) => !existing.has(file.path));
  const updated = files.filter((file) => existing.has(file.path) && existing.get(file.path) !== file.contentHash);
  const onDisk = new Set(files.map((file) => file.path));
  const removed = [...existing.keys()].filter((path) => !onDisk.has(path));
  const touched = [...updated.map((file) => file.path), ...removed];

  // Files with edges into anything that changed must be re-extracted: their
  // edges may now point at symbols that moved, vanished or were re-exported.
  const dependents = db
    .prepare(
      `SELECT DISTINCT s.path FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
       WHERE t.path IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(JSON.stringify(touched)) as string[];

  // A new file can satisfy an import that previously failed to resolve.
  const waitingForFiles =
    added.length === 0
      ? []
      : (db
          .prepare("SELECT path FROM nodes WHERE layer = 'file' AND json_array_length(metadata, '$.unresolvedImports') > 0")
          .pluck()
          .all() as string[]);

  const upsertFile = db.prepare(`
    INSERT INTO nodes (id, layer, type, name, path, language, content_hash, metadata)
    VALUES (@id, 'file', 'file', @name, @path, @language, @contentHash, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      language = excluded.language,
      content_hash = excluded.content_hash,
      metadata = excluded.metadata
  `);
  const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');
  const deleteEvidence = db.prepare('DELETE FROM evidence WHERE file_path = ?');

  const apply = () => {
    for (const file of [...added, ...updated]) {
      upsertFile.run({
        id: fileNodeId(file.path),
        name: basename(file.path),
        path: file.path,
        language: file.language,
        contentHash: file.contentHash,
        metadata: JSON.stringify({ size: file.size }),
      });
    }
    // Cascades to the file's symbols and every edge touching them.
    for (const path of removed) {
      deleteNode.run(fileNodeId(path));
      deleteEvidence.run(path);
    }
  };

  const dirty = new Set([...added, ...updated].map((file) => file.path));
  for (const path of [...dependents, ...waitingForFiles]) if (onDisk.has(path)) dirty.add(path);

  return {
    counts: { added: added.length, updated: updated.length, unchanged: files.length - added.length - updated.length, removed: removed.length },
    dirty: [...dirty],
    apply,
  };
}

function writeExtractions(db: XrayDb, extractions: FileExtraction[], languageOf: Map<string, string>): void {
  const upsertSymbol = db.prepare(`
    INSERT INTO nodes (id, parent_id, layer, type, name, path, symbol, language, start_line, end_line, metadata)
    VALUES (@id, @parentId, 'symbol', @type, @name, @path, @symbol, @language, @startLine, @endLine, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      type = excluded.type,
      name = excluded.name,
      symbol = excluded.symbol,
      language = excluded.language,
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      metadata = excluded.metadata
  `);
  const deleteStaleSymbols = db.prepare(
    "DELETE FROM nodes WHERE path = ? AND layer = 'symbol' AND id NOT IN (SELECT value FROM json_each(?))",
  );
  const deleteOutgoingEdges = db.prepare(
    "DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE path = ? AND layer IN ('file', 'symbol'))",
  );
  const deleteEvidence = db.prepare('DELETE FROM evidence WHERE file_path = ?');
  const setUnresolved = db.prepare(
    "UPDATE nodes SET metadata = json_set(metadata, '$.unresolvedImports', json(?)) WHERE id = ?",
  );
  const upsertExternal = db.prepare(`
    INSERT INTO nodes (id, layer, type, name) VALUES (@id, 'external', @type, @name)
    ON CONFLICT(id) DO NOTHING
  `);
  const nodeExists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').pluck();
  const insertEdge = db.prepare(`
    INSERT INTO edges (source, target, relation, resolution_type, confidence, metadata)
    VALUES (@source, @target, @relation, @resolutionType, @confidence, @metadata)
    ON CONFLICT(source, target, relation) DO UPDATE SET
      resolution_type = excluded.resolution_type,
      confidence = excluded.confidence,
      metadata = excluded.metadata
    RETURNING id
  `).pluck();
  const insertEvidence = db.prepare(`
    INSERT INTO evidence (file_path, start_line, end_line, rule, excerpt_hash)
    VALUES (@filePath, @startLine, @endLine, @rule, @excerptHash)
    RETURNING id
  `).pluck();
  const linkEvidence = db.prepare('INSERT OR IGNORE INTO edge_evidence (edge_id, evidence_id) VALUES (?, ?)');

  // Every file's symbols first, so edges between re-extracted files find their targets.
  for (const extraction of extractions) {
    const { path } = extraction;
    deleteOutgoingEdges.run(path);
    deleteEvidence.run(path);
    for (const symbol of extraction.symbols) {
      upsertSymbol.run({
        id: symbol.id,
        parentId: symbol.parentId ?? fileNodeId(path),
        type: symbol.type,
        name: symbol.name,
        path,
        symbol: symbol.qualifiedName,
        language: languageOf.get(path) ?? null,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        metadata: JSON.stringify(symbol.metadata),
      });
    }
    deleteStaleSymbols.run(path, JSON.stringify(extraction.symbols.map((symbol) => symbol.id)));
    setUnresolved.run(JSON.stringify(extraction.unresolvedImports), fileNodeId(path));
    for (const external of extraction.externals) upsertExternal.run(external);
  }

  for (const extraction of extractions) {
    for (const edge of extraction.edges) {
      // Targets can be missing when they live in a file no adapter extracts.
      if (!nodeExists.get(edge.target)) continue;
      const edgeId = insertEdge.get({
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        resolutionType: edge.resolutionType,
        confidence: edge.confidence,
        metadata: JSON.stringify(edge.metadata),
      });
      for (const item of edge.evidence) {
        const evidenceId = insertEvidence.get({ filePath: extraction.path, ...item });
        linkEvidence.run(edgeId, evidenceId);
      }
    }
  }
}

/** Re-parents every file under its folder cluster and drops clusters that are now empty. */
function writeClusters(db: XrayDb, files: ScannedFile[]): void {
  const clusters = clusterFiles(files.map((file) => file.path));
  const upsertCluster = db.prepare(`
    INSERT INTO nodes (id, layer, type, name, path, metadata) VALUES (@id, 'cluster', @type, @name, @path, @metadata)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, path = excluded.path, metadata = excluded.metadata
  `);
  const setParent = db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ? AND parent_id IS NOT ?');

  for (const cluster of clusters) {
    upsertCluster.run({
      id: cluster.id,
      type: cluster.prefix === null ? 'group' : 'folder',
      name: cluster.name,
      path: cluster.prefix,
      metadata: JSON.stringify({ fileCount: cluster.files.length, rule: 'folder-prefix' }),
    });
    for (const path of cluster.files) setParent.run(cluster.id, fileNodeId(path), cluster.id);
  }
  // Safe only after re-parenting: deleting a cluster cascades to its files.
  db.prepare("DELETE FROM nodes WHERE layer = 'cluster' AND id NOT IN (SELECT value FROM json_each(?))").run(
    JSON.stringify(clusters.map((cluster) => cluster.id)),
  );
}

function graphCounts(db: XrayDb) {
  const count = (sql: string) => (db.prepare(sql).pluck().get() as number) ?? 0;
  return {
    symbols: count("SELECT count(*) FROM nodes WHERE layer = 'symbol'"),
    imports: count("SELECT count(*) FROM edges WHERE relation = 'imports'"),
    calls: count("SELECT count(*) FROM edges WHERE relation = 'calls'"),
    externals: count("SELECT count(*) FROM nodes WHERE layer = 'external'"),
    clusters: count("SELECT count(*) FROM nodes WHERE layer = 'cluster'"),
    unresolvedImports: count(
      "SELECT coalesce(sum(json_array_length(metadata, '$.unresolvedImports')), 0) FROM nodes WHERE layer = 'file'",
    ),
  };
}

function hashProjectConfig(root: string): string {
  const hash = createHash('sha256');
  for (const name of PROJECT_CONFIG_FILES) {
    const path = join(root, name);
    hash.update(`${name}\0${existsSync(path) ? readFileSync(path, 'utf8') : ''}\0`);
  }
  return hash.digest('hex');
}
