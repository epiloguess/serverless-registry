import { errorString } from "./utils";

export type AccessStats = {
  digest: string;
  count: number;
  lastAccess: number;
};

// Record an access hit for a digest in a namespace.
// Each hit bumps the counter, so frequent pulls are accurately tracked.
// D1 write costs are negligible (free tier covers 5M row writes/day).
export async function recordAccess(db: D1Database, name: string, digest: string): Promise<void> {
  try {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO access_stats (name, digest, count, last_access)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(name, digest) DO UPDATE SET count = count + 1, last_access = excluded.last_access`,
      )
      .bind(name, digest, now)
      .run();
  } catch (err) {
    console.error(`Error recording access stats: ${errorString(err)}`);
  }
}

// List access stats for a namespace, ordered by access count descending.
export async function listHotResources(db: D1Database, name: string, limit = 0): Promise<AccessStats[]> {
  const rows = await db
    .prepare(
      `SELECT digest, count, last_access FROM access_stats WHERE name = ?1
       ORDER BY count DESC${limit > 0 ? " LIMIT ?2" : ""}`,
    )
    .bind(name, ...(limit > 0 ? [limit] : []))
    .all<{ digest: string; count: number; last_access: number }>();
  return rows.results.map((row) => ({
    digest: row.digest,
    count: row.count,
    lastAccess: row.last_access,
  }));
}

// Delete manifests (and their tags) that have not been accessed for more than `days` days.
// Returns the digests of the deleted manifests.
export async function listStaleManifests(db: D1Database, name: string, days: number): Promise<string[]> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await db
    .prepare(
      `SELECT digest FROM access_stats WHERE name = ?1 AND last_access < ?2
       ORDER BY last_access ASC`,
    )
    .bind(name, cutoff)
    .all<{ digest: string }>();
  return rows.results.map((row) => row.digest);
}

// Remove access stats rows that are no longer tracked.
export async function deleteAccessStats(db: D1Database, name: string, digests: string[]): Promise<void> {
  if (digests.length === 0) {
    return;
  }
  try {
    await db
      .prepare(`DELETE FROM access_stats WHERE name = ?1 AND digest IN (${digests.map(() => "?").join(",")})`)
      .bind(name, ...digests)
      .run();
  } catch (err) {
    console.error(`Error deleting access stats: ${errorString(err)}`);
  }
}

export type RepositorySummary = {
  name: string;
  digestCount: number;
  totalPulls: number;
  lastAccess: number;
  lastAccessHuman: string;
};

// Per-repository rollup across all tracked digests, for the dashboard.
export async function summarizeRepositories(db: D1Database): Promise<RepositorySummary[]> {
  const rows = await db
    .prepare(
      `SELECT name,
              COUNT(digest) AS digest_count,
              SUM(count) AS total_pulls,
              MAX(last_access) AS last_access
       FROM access_stats
       GROUP BY name
       ORDER BY total_pulls DESC`,
    )
    .all<{ name: string; digest_count: number; total_pulls: number; last_access: number }>();
  return rows.results.map((row) => ({
    name: row.name,
    digestCount: row.digest_count,
    totalPulls: row.total_pulls,
    lastAccess: row.last_access,
    lastAccessHuman: new Date(row.last_access).toISOString(),
  }));
}
