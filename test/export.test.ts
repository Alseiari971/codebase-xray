import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { openDatabase } from '../src/db/database.ts';
import { indexRepository } from '../src/indexer/indexer.ts';
import { exportReport, graphSnapshot } from '../src/report.ts';
import { copyFixture, makeRepo } from './helpers.ts';

const NOW = new Date('2026-10-15T12:00:00Z');

function indexedFixture() {
  const root = copyFixture();
  const db = openDatabase(':memory:');
  indexRepository(db, root);
  return { root, db };
}

/** The lines of one `## heading` section. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  assert.ok(start >= 0, `missing section ${heading}`);
  const next = markdown.indexOf('\n## ', start + 3);
  return markdown.slice(start, next === -1 ? undefined : next);
}

test('the Markdown report summarises the repository', () => {
  const { root, db } = indexedFixture();
  const report = exportReport(db, root, 'md', NOW);

  assert.match(report, /^# Architecture of xray-fixture-\w+\n/);
  assert.match(report, /on 2026-10-15 from the deterministic evidence graph/);
  const summary = section(report, 'Summary');
  assert.match(summary, /\| Files \| Symbols \| Clusters \| Import edges \| Call edges \| External packages \|/);
  assert.match(summary, /\| 11 \| 12 \| 8 \| 9 \| 13 \| 3 \|/);
  assert.match(summary, /- 1 edge is heuristic/);
  assert.match(summary, /- 1 import could not be resolved/);
});

test('the Mermaid diagram has a node per cluster and an arrow per dependency', () => {
  const { root, db } = indexedFixture();
  const diagram = section(exportReport(db, root, 'md', NOW), 'Cluster dependencies');
  const mermaid = diagram.slice(diagram.indexOf('```mermaid\n') + 11, diagram.lastIndexOf('```'));
  const lines = mermaid.trim().split('\n');

  assert.equal(lines[0], 'graph TD');
  const nodes = new Map(lines.filter((line) => line.includes('["')).map((line) => {
    const [, id, label] = /^ {2}(c\d+)\["([^"]+)"\]$/.exec(line)!;
    return [label!.split('<br/>')[0]!, id!];
  }));
  assert.deepEqual([...nodes.keys()].sort(), ['(root)', 'scripts', 'src', 'src/api', 'src/auth', 'src/db', 'src/notifications', 'src/ui']);
  assert.ok(lines.includes(`  ${nodes.get('src/api')} -->|2| ${nodes.get('src/auth')}`));
  assert.ok(lines.includes(`  ${nodes.get('src/auth')} -->|3| ${nodes.get('src/db')}`)); // one import, two calls
  // Every arrow joins two declared nodes.
  for (const arrow of lines.filter((line) => line.includes('-->'))) {
    const [, from, to] = /^ {2}(c\d+) -->\|\d+\| (c\d+)$/.exec(arrow)!;
    assert.ok([...nodes.values()].includes(from!) && [...nodes.values()].includes(to!), arrow);
  }
});

test('each cluster lists its files, dependencies and packages', () => {
  const { root, db } = indexedFixture();
  const clusters = section(exportReport(db, root, 'md', NOW), 'Clusters');
  const auth = clusters.slice(clusters.indexOf('### src/auth\n'), clusters.indexOf('### ', clusters.indexOf('### src/auth\n') + 4));
  assert.match(auth, /2 files, 2 symbols, 2 internal dependencies\./);
  assert.match(auth, /\| `src\/auth\/login\.ts` \| 1 \|/);
  assert.match(auth, /- \*\*Depends on:\*\* src\/db \(3\)/);
  assert.match(auth, /- \*\*Used by:\*\* src\/api \(2\)/);
  assert.match(auth, /- \*\*External packages:\*\* `node:fs`, `bcrypt`/);
});

test('entry points, hubs and packages', () => {
  const { root, db } = indexedFixture();
  const report = exportReport(db, root, 'md', NOW);
  const entries = section(report, 'Entry points');
  // Nothing imports these; notify.ts and LoginForm.tsx are unused too.
  for (const path of ['scripts/seed.ts', 'src/api/server.js', 'src/index.ts', 'src/notifications/notify.ts', 'src/ui/LoginForm.tsx']) {
    assert.match(entries, new RegExp(`\\| \`${path.replace(/[./]/g, '\\$&')}\` \\|`), path);
  }
  assert.match(entries, /\| `src\/ui\/LoginForm\.tsx` \| `Button`, `LoginForm` \|/);
  assert.doesNotMatch(entries, /src\/auth\/login\.ts/);

  // new UserRepository() in login() and in UserRepository.create.
  assert.match(section(report, 'Most depended-on code'), /\| `UserRepository` \| `src\/db\/user-repository\.ts:6` \| 2 \|/);
  assert.match(section(report, 'External packages'), /\| `bcrypt` \| npm \| 1 \|/);
});

test('the JSON snapshot is the whole graph, with evidence linked to edges', () => {
  const { root, db } = indexedFixture();
  const snapshot = graphSnapshot(db, root, NOW);
  const parsed = JSON.parse(exportReport(db, root, 'json', NOW));

  assert.equal(parsed.format, 'codebase-xray/graph');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.generatedAt, '2026-10-15T12:00:00.000Z');
  assert.match(parsed.repository, /^xray-fixture-/);
  assert.ok(!JSON.stringify(parsed).includes(root.replace(/\\/g, '\\\\')), 'no absolute paths');

  const count = (table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  assert.equal(snapshot.nodes.length, count('nodes'));
  assert.equal(snapshot.edges.length, count('edges'));
  assert.equal(snapshot.evidence.length, count('evidence'));

  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  for (const edge of snapshot.edges) {
    assert.ok(edge.evidence.length > 0, `edge ${edge.id} has evidence`);
    for (const id of edge.evidence) assert.ok(evidenceIds.has(id));
  }
  const login = parsed.nodes.find((node: { id: string }) => node.id === 'sym:src/auth/login.ts#login');
  assert.deepEqual([login.startLine, login.endLine, login.metadata.exported], [9, 14, true]);
});

test('xray export prints Markdown, or writes either format to --out', async () => {
  const root = copyFixture();
  const out: string[] = [];
  const io = { out: (line: string) => out.push(line), err: () => {} };
  assert.equal(await main(['index', root], io), 0);

  out.length = 0;
  assert.equal(await main(['export', root], io), 0);
  assert.match(out.join('\n'), /^# Architecture of/);

  const md = join(makeRepo({}), 'ARCHITECTURE.md');
  out.length = 0;
  assert.equal(await main(['export', root, '--out', md], io), 0);
  assert.match(out.join('\n'), /Wrote the architecture report to/);
  assert.match(readFileSync(md, 'utf8'), /```mermaid\ngraph TD/);

  const json = join(makeRepo({}), 'graph.json');
  assert.equal(await main(['export', root, '--format', 'json', '--out', json], io), 0);
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).format, 'codebase-xray/graph');

  assert.equal(await main(['export', root, '--format', 'pdf'], { out: () => {}, err: () => {} }), 2);
  assert.ok(!existsSync(join(root, 'graph.json')));
});
