-- Codebase X-Ray evidence graph (blueprint section 11).
--
-- The same tables back the CLI, the local web UI and the MCP server, so every
-- consumer reads the same repository-derived facts. This file is applied on
-- every open and must stay idempotent; bump SCHEMA_VERSION in database.ts when
-- a change is not backwards compatible.

-- Every thing on the map: clusters, files, symbols, datastores, external services.
-- parent_id forms the zoom hierarchy (cluster -> file -> symbol).
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  layer         TEXT NOT NULL
                CHECK (layer IN ('cluster', 'file', 'symbol', 'datastore', 'external')),
  type          TEXT NOT NULL,                 -- e.g. file, function, class, route, table, service
  name          TEXT NOT NULL,
  path          TEXT,                          -- repo-relative, forward slashes
  symbol        TEXT,                          -- fully qualified symbol name, symbol layer only
  language      TEXT,
  start_line    INTEGER CHECK (start_line IS NULL OR start_line >= 1),
  end_line      INTEGER CHECK (end_line IS NULL OR end_line >= start_line),
  content_hash  TEXT,                          -- sha256 of file contents, file layer only
  metadata      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata))
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_layer  ON nodes(layer);
CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);

-- Directed relationships (imports, calls, defines-route, reads-table, ...).
-- resolution_type drives the trust badge shown in the UI.
CREATE TABLE IF NOT EXISTS edges (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target           TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation         TEXT NOT NULL,
  resolution_type  TEXT NOT NULL
                   CHECK (resolution_type IN ('deterministic', 'heuristic', 'runtime_observed', 'ai_inferred')),
  confidence       REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  metadata         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  UNIQUE (source, target, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);

-- Exact source ranges that justify an edge. Keyed by file_path so a re-index of
-- one file can drop its evidence without touching the rest of the graph.
CREATE TABLE IF NOT EXISTS evidence (
  id            INTEGER PRIMARY KEY,
  file_path     TEXT NOT NULL,
  start_line    INTEGER NOT NULL CHECK (start_line >= 1),
  end_line      INTEGER NOT NULL CHECK (end_line >= start_line),
  rule          TEXT NOT NULL,                 -- parser rule or runtime observation that produced it
  excerpt_hash  TEXT                           -- sha256 of the cited lines, detects stale evidence
);

CREATE INDEX IF NOT EXISTS idx_evidence_file ON evidence(file_path);

-- An edge can cite several pieces of evidence (e.g. multiple call sites).
CREATE TABLE IF NOT EXISTS edge_evidence (
  edge_id      INTEGER NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  evidence_id  INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (edge_id, evidence_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_edge_evidence_evidence ON edge_evidence(evidence_id);

-- Nodes flagged `git-changed` by the latest diff (blueprint section 13:
-- working tree -> symbol). Replaced wholesale on every diff, so it is a
-- snapshot rather than history; MCP tools and the UI read it.
CREATE TABLE IF NOT EXISTS git_changes (
  node_id      TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL DEFAULT 'git-changed' CHECK (relation = 'git-changed'),
  status       TEXT NOT NULL CHECK (status IN ('added', 'modified', 'deleted', 'renamed', 'untracked')),
  base         TEXT NOT NULL,
  -- Changed line ranges inside the node, as [[start, end], ...] in the working tree.
  ranges       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ranges)),
  detected_at  TEXT NOT NULL
);

-- Index-level facts: repository root, last indexed time, tool version.
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
