// The repository at cluster level: sizes, largest files, and which clusters
// depend on which. Shared by the MCP tool and the exported report, so an agent
// and a README describe the architecture with the same numbers.

import { getMeta, type XrayDb } from '../db/database.ts';

export interface ClusterLink {
  cluster: string;
  edges: number;
  relations: string[];
}

export interface ClusterSummary {
  id: string;
  name: string;
  files: number;
  symbols: number;
  topFiles: { id: string; path: string; symbols: number }[];
  dependsOn: ClusterLink[];
  usedBy: ClusterLink[];
  /** Edges between nodes inside this cluster. */
  internalEdges: number;
  externals: string[];
}

export interface Architecture {
  root: string | null;
  indexedAt: string | null;
  totals: { files: number; symbols: number; externals: number; edges: number };
  clusters: ClusterSummary[];
}

/** Clusters, their size, top files, dependencies on each other and on packages. */
export function architecture(db: XrayDb): Architecture {
  const clusters = db
    .prepare(
      `SELECT c.id, c.name,
              (SELECT count(*) FROM nodes f WHERE f.parent_id = c.id) AS files,
              (SELECT count(*) FROM nodes s JOIN nodes f ON f.layer = 'file' AND f.path = s.path
                 WHERE s.layer = 'symbol' AND f.parent_id = c.id) AS symbols
       FROM nodes c WHERE c.layer = 'cluster' ORDER BY files DESC, c.id`,
    )
    .all() as { id: string; name: string; files: number; symbols: number }[];

  const topFiles = db.prepare(
    `SELECT f.id, f.path, (SELECT count(*) FROM nodes s WHERE s.layer = 'symbol' AND s.path = f.path) AS symbols
     FROM nodes f WHERE f.layer = 'file' AND f.parent_id = ? ORDER BY symbols DESC, f.path LIMIT 8`,
  );

  // Every file and symbol mapped to its cluster, then edges counted between clusters.
  const links = db
    .prepare(
      `WITH owner(id, cluster) AS (
         SELECT f.id, f.parent_id FROM nodes f WHERE f.layer = 'file'
         UNION ALL
         SELECT s.id, f.parent_id FROM nodes s JOIN nodes f ON f.layer = 'file' AND f.path = s.path WHERE s.layer = 'symbol'
       )
       SELECT so.cluster AS source, coalesce(t.cluster, e.target) AS target, e.relation, count(*) AS edges
       FROM edges e JOIN owner so ON so.id = e.source LEFT JOIN owner t ON t.id = e.target
       GROUP BY 1, 2, 3 ORDER BY edges DESC`,
    )
    .all() as { source: string; target: string; relation: string; edges: number }[];

  const totals = db
    .prepare(
      `SELECT (SELECT count(*) FROM nodes WHERE layer = 'file') AS files,
              (SELECT count(*) FROM nodes WHERE layer = 'symbol') AS symbols,
              (SELECT count(*) FROM nodes WHERE layer = 'external') AS externals,
              (SELECT count(*) FROM edges) AS edges`,
    )
    .get() as Architecture['totals'];

  const merge = (rows: typeof links, key: 'source' | 'target') => {
    const byOther = new Map<string, { cluster: string; edges: number; relations: string[] }>();
    for (const row of rows) {
      const other = row[key];
      const entry = byOther.get(other) ?? { cluster: other, edges: 0, relations: [] };
      entry.edges += row.edges;
      if (!entry.relations.includes(row.relation)) entry.relations.push(row.relation);
      byOther.set(other, entry);
    }
    return [...byOther.values()].sort((a, b) => b.edges - a.edges);
  };

  return {
    root: getMeta(db, 'root') ?? null,
    indexedAt: getMeta(db, 'indexed_at') ?? null,
    totals,
    clusters: clusters.map((cluster) => {
      const outgoing = links.filter((link) => link.source === cluster.id && link.target !== cluster.id);
      return {
        ...cluster,
        topFiles: topFiles.all(cluster.id) as ClusterSummary['topFiles'],
        dependsOn: merge(outgoing.filter((link) => link.target.startsWith('cluster:')), 'target'),
        usedBy: merge(links.filter((link) => link.target === cluster.id && link.source !== cluster.id), 'source'),
        internalEdges: links.filter((link) => link.source === cluster.id && link.target === cluster.id).reduce((sum, link) => sum + link.edges, 0),
        externals: [...new Set(outgoing.filter((link) => link.target.startsWith('ext:')).map((link) => link.target))].sort(),
      };
    }),
  };
}
