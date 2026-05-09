/**
 * LML provenance index for sub-PR 2.1 (S2 reader).
 *
 * Bulk-loads `entity.identity ⨝ entity.reconciliation_log` from LML's
 * discogs-cache PG once at job start (see `DATABASE_URL_DISCOGS`) and
 * exposes a synchronous in-memory lookup keyed by `(library_name, source)`.
 * The backfill's hot path can then resolve `(method, confidence)` for
 * every per-source row in O(1).
 *
 * The query plucks the latest reconciliation attempt per `(identity_id,
 * source)` tuple via Postgres `DISTINCT ON (...) ORDER BY created_at DESC`.
 * That's the ground truth for confidence assignment per the §3.4.1
 * matrix: `exact_match`, `name_variation`, `member_group`, `alias_match`,
 * `manual`, with the real confidence attached.
 *
 * Memory budget: ~24K identity rows × ≤6 sources × ~100 bytes ≈ 15 MB.
 * Trivial.
 */

import postgres from 'postgres';

/** Single row of the provenance bulk-load. Mirrors the SQL columns 1:1. */
export type ProvenanceRow = {
  library_name: string;
  source: string;
  method: string;
  confidence: number | null;
};

/** Lookup interface for the resolver's hot path. */
export type ProvenanceIndex = {
  lookup: (libraryName: string, source: string) => { method: string; confidence: number | null } | undefined;
  /** Number of distinct (library_name, source) keys in the index. */
  size: number;
};

/**
 * Build the index from already-fetched rows. Pure function — exported for
 * unit tests that don't need to spin up a PG connection.
 *
 * Lookups are case-sensitive byte-for-byte: Backend.artists.artist_name is
 * the canonical key, and the artist-identity-etl is responsible for
 * preserving the LML→Backend name shape verbatim. If the names drift, the
 * resolver's miss-fallback (`alias_match 0.85`) kicks in — preferable to
 * silently smoothing the drift with a normalization step.
 */
export const buildProvenanceIndex = (rows: ProvenanceRow[]): ProvenanceIndex => {
  const map = new Map<string, { method: string; confidence: number | null }>();
  // Pipe is safe — never appears in artist names or LML source enum values.
  const key = (libraryName: string, source: string): string => libraryName + '|' + source;
  for (const r of rows) {
    map.set(key(r.library_name, r.source), { method: r.method, confidence: r.confidence });
  }
  return {
    lookup: (libraryName, source) => map.get(key(libraryName, source)),
    size: map.size,
  };
};

/**
 * Bulk-load the provenance index from LML's discogs-cache PG. Single SELECT
 * at job start; releases the connection before returning.
 *
 * Caller is responsible for setting `DATABASE_URL_DISCOGS`. Throws when
 * unset (a job that needs S2 provenance cannot proceed without it).
 */
export const loadProvenanceIndex = async (
  databaseUrl: string | undefined = process.env.DATABASE_URL_DISCOGS
): Promise<ProvenanceIndex> => {
  if (!databaseUrl) {
    throw new Error(
      '[library-identity-backfill] DATABASE_URL_DISCOGS is not set; cannot load LML provenance index for S2.'
    );
  }
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql<ProvenanceRow[]>`
      SELECT DISTINCT ON (l.identity_id, l.source)
             i.library_name AS "library_name",
             l.source       AS "source",
             l.method       AS "method",
             l.confidence   AS "confidence"
      FROM entity.identity i
      JOIN entity.reconciliation_log l ON l.identity_id = i.id
      ORDER BY l.identity_id, l.source, l.created_at DESC
    `;
    return buildProvenanceIndex(rows);
  } finally {
    await sql.end();
  }
};
