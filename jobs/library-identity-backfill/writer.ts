/**
 * Dual-table writer for `library_identity` + `library_identity_source`
 * (per plan §3.2.2.2).
 *
 * Each call writes a single library_id atomically:
 *   1. Open `db.transaction()`.
 *   2. SELECT … FOR UPDATE on the existing main row (defense-in-depth per
 *      §5.1; the actual first-insert serialization comes from the
 *      `ON CONFLICT (library_id)` clause on the main-row UPSERT — the lock
 *      no-ops when no main row exists yet).
 *   3. INSERT/UPSERT each per-source row into `library_identity_source` with
 *      `ON CONFLICT (library_id, source) DO UPDATE`.
 *   4. Recompute the main-row values from the (now-current) per-source rows.
 *   5. UPSERT the main row into `library_identity` with
 *      `ON CONFLICT (library_id) DO UPDATE`.
 *
 * History (§5.1.1) — when the main row is superseded by a recompute, a
 * snapshot of the prior state moves to `library_identity_history` with
 * `superseded_reason='backfill_recompute'`. Sub-PR 2.0 only writes single-
 * source rows where no prior main row exists (idempotency WHERE filter),
 * so the history INSERT never fires from 2.0; the path is already wired so
 * 2.1+ supersedure cases are a single-line change in the orchestrator.
 *
 * No `metadata_attempt_at`-style marker exists on `library_identity` — the
 * idempotency strategy is set-membership against `library_identity` itself
 * (the orchestrator's WHERE filter), not a column-level marker.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { recomputeMainRow, type SourceRow } from './recompute.js';
import type { SourceRowToWrite } from './resolve.js';

/**
 * Schema-qualified table references. Honors `WXYC_SCHEMA_NAME` so parallel
 * Jest workers (which override the env var) and any future integration test
 * harness target the right schema. Default `wxyc_schema` matches production.
 * Sanitised against `"` to keep the SQL well-formed; same shape as
 * `library-canonical-entity-backfill/orchestrate.ts`.
 */
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_IDENTITY_TABLE = sql.raw(`"${SCHEMA}"."library_identity"`);
const LIBRARY_IDENTITY_SOURCE_TABLE = sql.raw(`"${SCHEMA}"."library_identity_source"`);

/**
 * Write the per-source rows + recomputed main row for `libraryId` atomically.
 *
 * `agreementSources` lists per-source `source` values that the caller's
 * cross-ref index has verified to corroborate this library_id. Sub-PR 2.0
 * passes `[]` (no cross-ref index built yet); 2.1+ populate it from the
 * §5.2 in-memory cross-ref pre-index.
 */
export const writeIdentity = async (
  libraryId: number,
  sourceRows: SourceRowToWrite[],
  agreementSources: string[]
): Promise<void> => {
  await db.transaction(async (tx) => {
    // Defense-in-depth lock on the existing main row, if any. No-op for
    // first inserts; serializes against any concurrent reader / writer when
    // a main row already exists.
    await tx.execute(sql`
      SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE}
      WHERE "library_id" = ${libraryId}
      FOR UPDATE
    `);

    for (const r of sourceRows) {
      await tx.execute(sql`
        INSERT INTO ${LIBRARY_IDENTITY_SOURCE_TABLE} (
          "library_id", "source", "external_id", "method", "confidence",
          "last_verified_at", "boost_sources", "notes"
        ) VALUES (
          ${r.library_id}, ${r.source}, ${r.external_id}, ${r.method}, ${r.confidence},
          ${r.last_verified_at}, ${r.boost_sources}, ${r.notes}
        )
        ON CONFLICT ("library_id", "source") DO UPDATE SET
          "external_id" = EXCLUDED."external_id",
          "method" = EXCLUDED."method",
          "confidence" = EXCLUDED."confidence",
          "last_verified_at" = EXCLUDED."last_verified_at",
          "boost_sources" = EXCLUDED."boost_sources",
          "notes" = EXCLUDED."notes"
      `);
    }

    const recomputeInputs: SourceRow[] = sourceRows.map((r) => ({
      source: r.source,
      external_id: r.external_id,
      method: r.method,
      confidence: r.confidence,
      boost_sources: r.boost_sources,
      last_verified_at: r.last_verified_at,
    }));
    const main = recomputeMainRow(recomputeInputs, agreementSources);

    await tx.execute(sql`
      INSERT INTO ${LIBRARY_IDENTITY_TABLE} (
        "library_id",
        "discogs_master_id", "discogs_release_id",
        "musicbrainz_release_group_mbid", "musicbrainz_release_mbid", "musicbrainz_recording_mbid",
        "wikidata_qid", "spotify_id", "apple_music_id",
        "last_verified_at", "method", "confidence", "agreement_sources", "notes"
      ) VALUES (
        ${libraryId},
        ${main.discogs_master_id}, ${main.discogs_release_id},
        ${main.musicbrainz_release_group_mbid}, ${main.musicbrainz_release_mbid}, ${main.musicbrainz_recording_mbid},
        ${main.wikidata_qid}, ${main.spotify_id}, ${main.apple_music_id},
        ${main.last_verified_at}, ${main.method}, ${main.confidence}, ${main.agreement_sources}, ${null}
      )
      ON CONFLICT ("library_id") DO UPDATE SET
        "discogs_master_id" = EXCLUDED."discogs_master_id",
        "discogs_release_id" = EXCLUDED."discogs_release_id",
        "musicbrainz_release_group_mbid" = EXCLUDED."musicbrainz_release_group_mbid",
        "musicbrainz_release_mbid" = EXCLUDED."musicbrainz_release_mbid",
        "musicbrainz_recording_mbid" = EXCLUDED."musicbrainz_recording_mbid",
        "wikidata_qid" = EXCLUDED."wikidata_qid",
        "spotify_id" = EXCLUDED."spotify_id",
        "apple_music_id" = EXCLUDED."apple_music_id",
        "last_verified_at" = EXCLUDED."last_verified_at",
        "method" = EXCLUDED."method",
        "confidence" = EXCLUDED."confidence",
        "agreement_sources" = EXCLUDED."agreement_sources"
    `);
  });
};
