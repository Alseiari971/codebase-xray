# Codebase X-Ray

[![CI](https://github.com/Alseiari971/codebase-xray/actions/workflows/ci.yml/badge.svg)](https://github.com/Alseiari971/codebase-xray/actions/workflows/ci.yml)

**AI can build your software. Now understand what it built.**

Codebase X-Ray turns a repository into an interactive map of how it actually works: architecture, dependencies, feature flows, and change impact. Every relationship on the map traces back to exact source lines. The same local evidence graph serves a browser UI and an MCP server, so you and your coding agent work from the same facts.

> **Status: Phase 1 (foundation).** The CLI, SQLite evidence-graph schema and incremental file indexer work. Symbol extraction, the web UI, diff overlay and MCP server are still to come (see [Roadmap](#roadmap)).

## Quick start

Requires Node.js 20.6 or newer.

```bash
git clone https://github.com/Alseiari971/codebase-xray.git
cd codebase-xray
npm install
npm run xray -- index ../my-project
```

To put `xray` on your PATH, run `npm link` once.

## Commands

| Command | What it does | Status |
| --- | --- | --- |
| `xray index <path>` | Build or refresh the evidence graph in `<path>/.xray/index.db` | Working (file layer) |
| `xray serve <path>` | Local web UI and HTTP/JSON API | Planned |
| `xray diff [path]` / `xray --uncommitted` | Overlay uncommitted changes and their downstream impact | Planned |
| `xray mcp <path>` | Read-only MCP server for Claude Code, Cursor, Windsurf, etc. | Planned |
| `xray <path>` | Index, then serve | Index only for now |

Options: `--db <file>` to store the index somewhere else, `--port <n>` for `serve`, `--base <ref>` for `diff`.

Indexing is incremental. Each file's SHA-256 `content_hash` is stored, so unchanged files are skipped on the next run. Changed or deleted files have their symbols and evidence cleared for re-analysis. The root `.gitignore` is honoured, and `node_modules/`, `.git/` and `.xray/` are always skipped.

## Evidence graph

The schema lives in [`src/db/schema.sql`](src/db/schema.sql) and follows section 11 of the project blueprint.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `nodes` | Clusters, files, symbols, datastores, external services | `id`, `parent_id` (zoom hierarchy), `layer`, `type`, `name`, `path`, `symbol`, `language`, `start_line`, `end_line`, `content_hash`, `metadata` |
| `edges` | Relationships such as `imports`, `calls`, `defines-route`, `reads-table` | `source`, `target`, `relation`, `resolution_type`, `confidence` (0 to 1) |
| `evidence` | Exact source ranges that justify an edge | `file_path`, `start_line`, `end_line`, `rule`, `excerpt_hash` |
| `edge_evidence` | Links each edge to one or more pieces of evidence | `edge_id`, `evidence_id` |
| `meta` | Index facts: repository root, last indexed time | `key`, `value` |

`layer` is one of `cluster | file | symbol | datastore | external`. `resolution_type` is one of `deterministic | heuristic | runtime_observed | ai_inferred` and drives the trust badge on every edge. Deleting a node cascades to its children, its edges and their evidence links.

## Development

```bash
npm test           # node:test suite (schema, indexer, CLI)
npm run typecheck  # tsc --noEmit
```

The sources run directly through [tsx](https://tsx.is), so there is no build step. `better-sqlite3` is pinned to `12.9.0` because it is the newest release with prebuilt Windows binaries for Node 20, 22 and 24. That means `npm install` doesn't need a C++ toolchain.

## Roadmap

- [x] **Phase 1: Foundation.** CLI skeleton, SQLite schema, incremental file indexing
- [ ] ts-morph TypeScript/JavaScript adapter: symbols, imports, exports, routes, call graph with evidence
- [ ] `xray serve`: HTTP/JSON API (`/api/graph`, `/api/node/:id/evidence`, `/api/flow`, `/api/diff`) and React Flow UI
- [ ] Deterministic flow tracing and blast-radius queries
- [ ] `xray diff`: Git working tree and branch diff overlay
- [ ] `xray mcp`: read-only MCP tools (`get_architecture_clusters`, `trace_flow`, `get_blast_radius`, `get_node_evidence`, `get_changed_nodes`)
- [ ] Grounded AI explanations (optional, bring your own key)
- [ ] Exports: SVG, JSON, Markdown
