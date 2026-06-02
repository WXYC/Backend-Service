/**
 * Local `wxyc_library_alt` composer leg for artist-search-alias-consumer.
 *
 * Reads `library.alternate_artist_name` aggregated per `artist_id` so the
 * orchestrator can fan a single SELECT out across the whole batch (one
 * round-trip, not one per artist).
 *
 * The orchestrator tags every variant returned from this source as
 * `wxyc_library_alt` with confidence 0.85 (parity with `discogs_alias` —
 * `library.alternate_artist_name` is editorially uneven under tubafrenzy's
 * loose conventions; this calibration is documented in the artist-search-
 * alias plan and re-rankable as v2 once observed precision data exists).
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);

type AltRow = { artist_id: number; alts: string[] };

/**
 * For the supplied artist_ids, returns a Map<artist_id, string[]> of
 * distinct non-null `library.alternate_artist_name` values. Artist_ids with
 * no non-null alts simply don't appear in the Map — the orchestrator's
 * `.get(id) ?? []` fallback handles that case without an extra branch.
 *
 * Short-circuits with zero PG work when the input is empty.
 */
export const fetchAlternateArtistNames = async (artistIds: number[]): Promise<Map<number, string[]>> => {
  if (artistIds.length === 0) return new Map<number, string[]>();

  const raw: unknown = await db.execute(sql`
    SELECT
      l."artist_id" AS artist_id,
      array_agg(DISTINCT l."alternate_artist_name") AS alts
    FROM ${LIBRARY_TABLE} l
    WHERE l."artist_id" = ANY(${artistIds}::int[])
      AND l."alternate_artist_name" IS NOT NULL
    GROUP BY l."artist_id"
  `);

  let rows: AltRow[] = [];
  if (Array.isArray(raw)) {
    rows = raw as AltRow[];
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) {
    rows = (raw as { rows: AltRow[] }).rows;
  }

  const map = new Map<number, string[]>();
  for (const r of rows) {
    map.set(r.artist_id, r.alts);
  }
  return map;
};
