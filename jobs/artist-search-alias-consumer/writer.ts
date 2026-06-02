/**
 * Writer for the artist-search-alias-consumer (BS#1266).
 *
 * Reconcile + UPSERT one artist's alias variants in one transaction. The
 * DELETE is scoped to the `sources_present` set the composer told us about
 * so a partial-composer response (e.g., the future MusicBrainz leg breaks
 * for one batch) does not wipe out rows from other sources.
 *
 * Three branches:
 *   1. `sourcesPresent.length === 0` — no composer leg ran. We cannot tell
 *      "deleted upstream" from "leg didn't run" so leave the cache
 *      untouched. Short-circuit with no transaction and no SQL.
 *   2. `variants.length === 0` with non-empty `sourcesPresent` — scoped
 *      DELETE only (the leg(s) ran and returned no variants for this
 *      artist; reconcile away any stale rows from those sources).
 *   3. Otherwise — scoped DELETE excluding the new `(source, variant)`
 *      pairs (anti-churn so the UPSERT updates them in place), then one
 *      `INSERT … ON CONFLICT (artist_id, source, variant) DO UPDATE` per
 *      variant.
 *
 * Two BS-incident-driven invariants:
 *   - **No `'{...}'::text[]` literals.** Variant strings can carry commas,
 *     apostrophes, and Unicode ("Earth, Wind & Fire" / "Sinéad O'Connor").
 *     The Drizzle/postgres-js array-literal pattern silently corrupts
 *     these (BS#1068-1073). Use parameterised `VALUES (…, …), (…, …)` —
 *     one positional bind per text — via `sql.join`. Precedent:
 *     `jobs/artist-identity-etl/runIncremental.ts:116-149`.
 *   - **Pre-stringify `last_verified_at`.** Drizzle's drizzle() factory
 *     overrides postgres-js's date serializer for OIDs 1184/1082/1083/etc.
 *     with a passthrough — a `Date` passed via `${...}` in a `sql\`\``
 *     template arrives at `Bind()` as a Date, the transparent serializer
 *     returns it unchanged, and `Buffer.byteLength()` inside `b.str()`
 *     throws ERR_INVALID_ARG_TYPE (BS#802 cost 14,405 UPSERTs in prod).
 *     Use `new Date().toISOString()` to defeat the override.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { ArtistSearchAliasVariant } from './lml-types.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ARTIST_SEARCH_ALIAS_TABLE = sql.raw(`"${SCHEMA}"."artist_search_alias"`);

export type WriteOutcome = {
  variants_written: number;
};

/**
 * Reconcile one artist's alias variants. Returns the per-call counts the
 * orchestrator accumulates. On any error the transaction rolls back; the
 * caller is responsible for catching + counting the failure.
 */
export const writeArtistVariants = async (
  artist_id: number,
  variants: ArtistSearchAliasVariant[],
  sourcesPresent: string[]
): Promise<WriteOutcome> => {
  if (sourcesPresent.length === 0) {
    // No composer leg ran — leave the cache untouched.
    return { variants_written: 0 };
  }

  // Defensive filter against the `artist_search_alias_variant_nonblank`
  // CHECK constraint. A single blank-after-trim variant rolls the whole
  // per-artist transaction back, dropping every other valid variant for
  // this artist_id. The most realistic source is a whitespace-only
  // `library.alternate_artist_name` from upstream free-text entry, which
  // alt-name-source.ts forwards as a `wxyc_library_alt` variant (it only
  // filters NULL). Drop blanks at the writer boundary so one bad row
  // doesn't poison the whole artist's run.
  const filteredVariants = variants.filter((v) => v.variant.trim().length > 0);

  const lastVerifiedAt = new Date().toISOString(); // Pre-stringify (BS#802 trap).

  let variantsWritten = 0;

  await db.transaction(async (tx) => {
    // Parameterised VALUES for the source list. Each source binds one
    // positional text param; comma-/quote-safe.
    const srcValues = sourcesPresent.map((s) => sql`(${s}::text)`);

    if (filteredVariants.length === 0) {
      await tx.execute(sql`
        DELETE FROM ${ARTIST_SEARCH_ALIAS_TABLE}
        WHERE "artist_id" = ${artist_id}
          AND "source" IN (SELECT s FROM (VALUES ${sql.join(srcValues, sql`, `)}) AS srcs(s))
      `);
      return;
    }

    // Same parameterised pattern for the `(source, variant)` pair list.
    // Each pair binds two positional text params — comma-/quote-safe.
    const pairValues = filteredVariants.map((v) => sql`(${v.source}::text, ${v.variant}::text)`);

    await tx.execute(sql`
      DELETE FROM ${ARTIST_SEARCH_ALIAS_TABLE}
      WHERE "artist_id" = ${artist_id}
        AND "source" IN (SELECT s FROM (VALUES ${sql.join(srcValues, sql`, `)}) AS srcs(s))
        AND ("source", "variant") NOT IN (
          VALUES ${sql.join(pairValues, sql`, `)}
        )
    `);

    for (const v of filteredVariants) {
      await tx.execute(sql`
        INSERT INTO ${ARTIST_SEARCH_ALIAS_TABLE}
          ("artist_id", "source", "variant", "related_artist_id",
           "external_subject_id", "external_object_id", "active",
           "method", "confidence", "last_verified_at")
        VALUES
          (${artist_id}, ${v.source}, ${v.variant}, ${v.related_artist_id},
           ${v.external_subject_id}, ${v.external_object_id}, ${v.active},
           ${v.method}, ${v.confidence}, ${lastVerifiedAt})
        ON CONFLICT ("artist_id", "source", "variant") DO UPDATE SET
          "related_artist_id"   = EXCLUDED."related_artist_id",
          "external_subject_id" = EXCLUDED."external_subject_id",
          "external_object_id"  = EXCLUDED."external_object_id",
          "active"              = EXCLUDED."active",
          "method"              = EXCLUDED."method",
          "confidence"          = EXCLUDED."confidence",
          "last_verified_at"    = EXCLUDED."last_verified_at"
      `);
      variantsWritten += 1;
    }
  });

  return { variants_written: variantsWritten };
};
