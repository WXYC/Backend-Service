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
 * Three BS-incident-driven invariants:
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
 *   - **Coerce nullable interpolations to `null` (not `undefined`).**
 *     Drizzle's `sql` tag interpolates `undefined` as an empty parameter
 *     position, producing invalid `VALUES (…, , …)` syntax. LML can emit
 *     sparse JSON for `discogs_name_variation` rows (all relationship
 *     columns missing), which `JSON.parse` materialises as `undefined`
 *     rather than `null`. Use `${v.field ?? null}` on every nullable
 *     column (BS#1300 cost 899 writer_errors on the 2026-06-03 first
 *     prod run — ~20% of substrate rows).
 *
 * One substrate-cleanup invariant (BS#1382, from the BS#1368 Path A audit):
 *   - **Reject no-op `discogs_name_variation` variants where
 *     `normalizeArtistName(variant) === normalizeArtistName(canonical)`.**
 *     The consumer's match arm normalizes both sides before comparing, so a
 *     variant whose normalized form equals the canonical's contributes zero
 *     recall over the canonical row — anything that would match the variant
 *     already matches the canonical post-normalization — while actively
 *     introducing FPs by colliding the de-normalized form against same-named
 *     distinct library artists ("The Format" → "Format" colliding with a
 *     different "Format"). The rule is expressed against the shared
 *     `normalizeArtistName` so writer-reject and consumer-match cannot
 *     drift; it covers the leading-"The" subform plus any future expansion
 *     of the normalization key (case-only, accent-only, etc.). Scoped to
 *     `discogs_name_variation` because it is the only source LML emits as a
 *     pure name-shape synonym — `discogs_alias` / `discogs_member` /
 *     `wxyc_library_alt` carry relational or curatorial signal even when
 *     their text normalizes to the canonical. The one-shot cleanup of
 *     existing rows lives at `scripts/cleanup-no-op-name-variations.sql`.
 */

import { sql } from 'drizzle-orm';
import { db, normalizeArtistName } from '@wxyc/database';

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
 *
 * `canonicalName` is the canonical `artists.artist_name` for `artist_id` and
 * is used to gate no-op `discogs_name_variation` rows out of the substrate
 * at write time (BS#1382). Passing the canonical here — rather than
 * re-reading it from the DB inside the writer — keeps the writer free of an
 * extra round-trip per artist; the orchestrator already has the grouped
 * canonical (`NameGroup.artist_name`) on hand.
 */
export const writeArtistVariants = async (
  artist_id: number,
  canonicalName: string,
  variants: ArtistSearchAliasVariant[],
  sourcesPresent: string[]
): Promise<WriteOutcome> => {
  if (sourcesPresent.length === 0) {
    // No composer leg ran — leave the cache untouched.
    return { variants_written: 0 };
  }

  // BS#1382: reject `discogs_name_variation` rows whose normalized form
  // equals the normalized canonical. Anything that would match the variant
  // already matches the canonical post-normalization (the consumer
  // normalizes both sides before comparing), so the row is pure dead
  // weight — and it actively introduces FPs by colliding the de-normalized
  // form against same-named distinct library artists. Scoped to
  // `discogs_name_variation` because `discogs_alias` / `discogs_member` /
  // `wxyc_library_alt` carry relational or curatorial signal that doesn't
  // collapse on normalization.
  const normalizedCanonical = normalizeArtistName(canonicalName);
  const nonNoopVariants = variants.filter(
    (v) => v.source !== 'discogs_name_variation' || normalizeArtistName(v.variant) !== normalizedCanonical
  );

  // Defensive filter against the `artist_search_alias_variant_nonblank`
  // CHECK constraint. A single blank-after-trim variant rolls the whole
  // per-artist transaction back, dropping every other valid variant for
  // this artist_id. The most realistic source is a whitespace-only
  // `library.alternate_artist_name` from upstream free-text entry, which
  // alt-name-source.ts forwards as a `wxyc_library_alt` variant (it only
  // filters NULL). Drop blanks at the writer boundary so one bad row
  // doesn't poison the whole artist's run.
  const filteredVariants = nonNoopVariants.filter((v) => v.variant.trim().length > 0);

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
          (${artist_id}, ${v.source}, ${v.variant}, ${v.related_artist_id ?? null},
           ${v.external_subject_id ?? null}, ${v.external_object_id ?? null}, ${v.active ?? null},
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
