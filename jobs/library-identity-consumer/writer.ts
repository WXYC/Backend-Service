/**
 * Writer for the library-identity-consumer (BS#802).
 *
 * Post-#800 pivot: LML composes; Backend writes. For each `BulkResolveResult`
 * we open a `db.transaction()` and atomically:
 *   1. SELECT … FOR UPDATE on the main row (defense-in-depth lock; no-op on
 *      first-insert — the real serialisation is `ON CONFLICT (library_id)`).
 *   2. UPSERT one row per `provenance` entry into `library_identity_source`
 *      with `ON CONFLICT (library_id, source) DO UPDATE`.
 *   3. UPSERT the denormalised main row into `library_identity` with
 *      `ON CONFLICT (library_id) DO UPDATE`. The (method, confidence) and
 *      `agreement_sources` on the main row come straight from LML — Backend
 *      no longer composes them.
 *
 * Provenance rows with `confidence === null` are skipped: the substrate
 * check constraint requires `confidence BETWEEN 0 AND 1` and NOT NULL.
 * Per the LML contract this only happens when `external_id` is also null,
 * which corresponds to a provenance entry that contributes signal but no
 * concrete external id — Backend has nowhere to store that today.
 *
 * The `kind: 'unresolved'` case writes nothing (the orchestrator counts it
 * separately). `kind: 'compilation'` results whose per-track matcher has not
 * yet run are still counted as `rows_skipped` before reaching the writer;
 * results whose matcher DID run this batch are written by
 * `writeCompilationTracks` below (BS#1991 / #801 S2) — a page-level function,
 * not a per-result one, so it can fetch the page's `compilation_track_artist`
 * rows and resolve artist names in one query each.
 *
 * MAIN-ROW COLUMN GAP
 * ===================
 * LML's `ReconciledIdentity` carries six artist-level external IDs:
 * `discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`,
 * `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id`. Only three
 * (wikidata, spotify, apple_music) have main-row destinations on
 * `library_identity` today — the rest are release/recording-level columns.
 *
 * The artist-level IDs without a main-row column are NOT lost: each LML
 * provenance entry's `external_id` (text) carries the per-source id
 * verbatim into `library_identity_source`. The main row is therefore a
 * partial denormalised view of the per-source rows until a follow-up
 * migration adds artist-id columns. Mapping is called out in the BS#802
 * PR body so the reviewer can land a migration in a separate PR.
 */

import { sql } from 'drizzle-orm';
import { db, intArrayLiteral } from '@wxyc/database';

import type { BulkResolveResult, BulkResolveTrackEntry, ReconciledIdentity } from './lml-types.js';
import { log } from './logger.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const LIBRARY_IDENTITY_TABLE = sql.raw(`"${SCHEMA}"."library_identity"`);
const LIBRARY_IDENTITY_SOURCE_TABLE = sql.raw(`"${SCHEMA}"."library_identity_source"`);
const COMPILATION_TRACK_ARTIST_TABLE = sql.raw(`"${SCHEMA}"."compilation_track_artist"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const FOLD_ARTIST_NAME_FN = sql.raw(`"${SCHEMA}"."fold_artist_name"`);

/**
 * Write categories the orchestrator counts. `unresolved` and `compilation`
 * are handled before this function is called; this function returns the
 * disposition for `single_artist` only (success/error are signalled by
 * throwing or completing).
 */
export type WriteOutcome = {
  source_rows_written: number;
  source_rows_skipped_null_confidence: number;
};

/**
 * Project the LML main payload onto `library_identity` columns. The
 * artist-id columns without main-row destinations (discogs_artist_id,
 * musicbrainz_artist_id, bandcamp_id) are dropped from the main row but
 * preserved in provenance — see the file header for the rationale and
 * follow-up migration plan.
 */
type MainRowFields = {
  discogs_master_id: number | null;
  discogs_release_id: number | null;
  musicbrainz_release_group_mbid: string | null;
  musicbrainz_release_mbid: string | null;
  musicbrainz_recording_mbid: string | null;
  wikidata_qid: string | null;
  spotify_id: string | null;
  apple_music_id: string | null;
};

export const projectMainRow = (main: ReconciledIdentity): MainRowFields => ({
  // Release/recording-level columns: not in the LML contract today. Per the
  // BS#800 pivot, these are LML's to compose if/when it surfaces them.
  discogs_master_id: null,
  discogs_release_id: null,
  musicbrainz_release_group_mbid: null,
  musicbrainz_release_mbid: null,
  musicbrainz_recording_mbid: null,
  // Artist-level columns that have a destination on library_identity.
  wikidata_qid: main.wikidata_qid ?? null,
  spotify_id: main.spotify_artist_id ?? null,
  apple_music_id: main.apple_music_artist_id ?? null,
  // discogs_artist_id, musicbrainz_artist_id, bandcamp_id: no main-row
  // destination on library_identity yet — carried by provenance rows
  // only. Follow-up migration tracked in the BS#802 PR body.
});

/**
 * Write the verdict for a single library_id atomically.
 *
 * Returns the per-row counts the orchestrator accumulates. For
 * `kind: 'single_artist'`, both per-source rows and main row land in one
 * transaction; rollback on any error leaves the database untouched.
 *
 * The caller is responsible for only calling this with
 * `kind: 'single_artist'` (the orchestrator dispatches `unresolved` and
 * `compilation` to counters without involving the writer).
 */
export const writeSingleArtist = async (
  result: Extract<BulkResolveResult, { kind: 'single_artist' }>
): Promise<WriteOutcome> => {
  const main = projectMainRow(result.main);
  // ISO-8601 string, not a JS Date object. Drizzle's drizzle() factory
  // overrides postgres-js's default date serializer (OIDs 1184/1082/1083/1114/1182/1185/1115/1231)
  // with a passthrough — see node_modules/drizzle-orm/postgres-js/driver.js:19, citing
  // https://github.com/porsager/postgres/discussions/761. The override is intended for
  // *parsers* (so reads return raw text), but it also catches the *serializer* path —
  // a JS Date passed via `${...}` in a `sql\`\`` template arrives at postgres-js's
  // Bind() as a Date, the transparent serializer returns it unchanged, and the
  // Buffer.byteLength() call inside b.str() throws ERR_INVALID_ARG_TYPE.
  // Pre-stringifying defeats the override and gives PG a parseable timestamptz.
  // 2026-05-20: every UPSERT of the first prod run (14,405/14,405) failed on this.
  const lastVerifiedAt = new Date().toISOString();

  let sourceRowsWritten = 0;
  let sourceRowsSkippedNullConfidence = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE}
      WHERE "library_id" = ${result.library_id}
      FOR UPDATE
    `);

    for (const p of result.provenance) {
      if (p.confidence === null) {
        // The substrate's BETWEEN-NOT-NULL constraint forbids null
        // confidence; LML emits this when external_id is also null, which
        // means the provenance entry contributes no concrete id. Skip
        // rather than violate the constraint.
        sourceRowsSkippedNullConfidence += 1;
        continue;
      }
      await tx.execute(sql`
        INSERT INTO ${LIBRARY_IDENTITY_SOURCE_TABLE} (
          "library_id", "source", "external_id", "method", "confidence",
          "last_verified_at", "boost_sources", "notes"
        ) VALUES (
          ${result.library_id}, ${p.source}, ${p.external_id}, ${p.method}, ${p.confidence},
          ${lastVerifiedAt}, ${null}, ${'consumer:lml-bulk'}
        )
        ON CONFLICT ("library_id", "source") DO UPDATE SET
          "external_id" = EXCLUDED."external_id",
          "method" = EXCLUDED."method",
          "confidence" = EXCLUDED."confidence",
          "last_verified_at" = EXCLUDED."last_verified_at",
          "boost_sources" = EXCLUDED."boost_sources",
          "notes" = EXCLUDED."notes"
      `);
      sourceRowsWritten += 1;
    }

    await tx.execute(sql`
      INSERT INTO ${LIBRARY_IDENTITY_TABLE} (
        "library_id",
        "discogs_master_id", "discogs_release_id",
        "musicbrainz_release_group_mbid", "musicbrainz_release_mbid", "musicbrainz_recording_mbid",
        "wikidata_qid", "spotify_id", "apple_music_id",
        "last_verified_at", "method", "confidence", "agreement_sources", "notes"
      ) VALUES (
        ${result.library_id},
        ${main.discogs_master_id}, ${main.discogs_release_id},
        ${main.musicbrainz_release_group_mbid}, ${main.musicbrainz_release_mbid}, ${main.musicbrainz_recording_mbid},
        ${main.wikidata_qid}, ${main.spotify_id}, ${main.apple_music_id},
        ${lastVerifiedAt}, ${result.method}, ${result.confidence}, ${null}, ${'consumer:lml-bulk'}
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
        "agreement_sources" = EXCLUDED."agreement_sources",
        "notes" = EXCLUDED."notes"
    `);
  });

  return {
    source_rows_written: sourceRowsWritten,
    source_rows_skipped_null_confidence: sourceRowsSkippedNullConfidence,
  };
};

/**
 * BS#974: stamp the `library.unresolved_attempted_at` no-match marker on the
 * given library ids. Called (flag-on, non-dry-run) with the batch's
 * `unresolved` + `compilation` library_ids — the rows LML *responded* on with
 * a definitive non-resolution — so a manual re-run doesn't re-burn LML on them
 * within `UNRESOLVED_RETRY_DAYS`. NOT called for `single_artist` (its
 * `library_identity` row is the success marker) or for transient failures
 * (`writer_error`/`lml_error`/cardinality/untrusted — those stay retryable).
 *
 * Binds the ids as a single Postgres array literal (`= ANY('{...}'::int[])`)
 * rather than an `IN (...)` splat, per BS#1071/#1072. Empty input is a no-op
 * (no query). The literal is built via `@wxyc/database`'s `intArrayLiteral`,
 * which round-trips every id through `Number(...)` and a real
 * `Number.isSafeInteger` check rather than trusting the `number[]` parameter
 * type — see that helper's docblock for why "the caller's type says so" isn't
 * a runtime guarantee.
 *
 * One harmless behavior delta from the hand-rolled join this replaced: a
 * malformed id now throws inside `intArrayLiteral` instead of being spliced
 * into a bad literal for Postgres to reject. Both outcomes land in the same
 * `try`/`catch` at `orchestrate.ts` (around the `stampUnresolvedAttemptedAt`
 * call site) and produce the same `stamp_error` warn-and-continue, so the
 * drain behaves identically either way — and the path is unreachable in
 * practice absent an unchecked cast upstream, since this parameter is typed
 * `number[]`.
 */
export const stampUnresolvedAttemptedAt = async (libraryIds: number[]): Promise<void> => {
  if (libraryIds.length === 0) return;
  await db.execute(sql`
    UPDATE ${LIBRARY_TABLE}
    SET "unresolved_attempted_at" = NOW()
    WHERE "id" = ANY(${intArrayLiteral(libraryIds)}::int[])
  `);
};

/**
 * Per-track writer for `kind: 'compilation'` results whose per-track matcher
 * ran this batch (BS#1991 / #801 S2). Operates on a whole page's worth of
 * results at once — not per-result — so the CTA fetch and the artist-name
 * resolution are each ONE query for the page (no N+1), per the AC.
 */
export type CompilationWriteOutcome = {
  /** CTA rows the batched UPDATE actually changed (via `RETURNING`) — the `IS DISTINCT FROM` guard means a no-op re-drain reports 0 here, not the attempted count. */
  rows_written: number;
  /** Matched, non-librarian rows already carrying this exact verdict — never queued, so a fully-unchanged page issues NO UPDATE statement (the 0138 watermark trigger is FOR EACH STATEMENT and fires even on `UPDATE 0` for whatever it watches — as of BS#2054/migration 0143 that no longer includes any column this writer sets, see `buildWriteRow`'s docstring). */
  rows_skipped_unchanged: number;
  /** CTA row already carries `track_artist_link_method = 'librarian'` — never overwritten. */
  rows_skipped_librarian: number;
  /** Track entry's (artist_name, track_title) echo matched no CTA row for that library_id. */
  rows_skipped_no_cta_match: number;
  /**
   * `resolved_artist_name` present but zero or 2+ `artists` rows share its
   * fold key. NOT disjoint from `rows_skipped_unchanged`: a row whose NULL
   * verdict is already stored counts in both on a re-drain (this bucket
   * answers "why NULL", that one answers "why no write"), so the skip
   * counters don't sum against `rows_written`.
   */
  rows_skipped_no_catalog_artist: number;
  /** CTA row's `track_position` was NULL and exactly one distinct position was offered. */
  position_rows_written: number;
  /** Two+ track entries shared the same (artist_name, track_title) key with differing positions. */
  position_rows_skipped_ambiguous: number;
};

type CtaRow = {
  id: number;
  library_id: number;
  artist_name: string;
  track_title: string | null;
  track_position: string | null;
  track_artist_link_method: string | null;
  track_artist_id: number | null;
  track_artist_link_confidence: number | null;
};

const emptyCompilationWriteOutcome = (): CompilationWriteOutcome => ({
  rows_written: 0,
  rows_skipped_unchanged: 0,
  rows_skipped_librarian: 0,
  rows_skipped_no_cta_match: 0,
  rows_skipped_no_catalog_artist: 0,
  position_rows_written: 0,
  position_rows_skipped_ambiguous: 0,
});

/** `(library_id, artist_name, track_title)` — CTA's own unique key (migration 0037/0099). */
const ctaKey = (libraryId: number, artistName: string, trackTitle: string | null): string =>
  JSON.stringify([libraryId, artistName, trackTitle]);

const fetchCtaRowsForLibraries = async (libraryIds: number[]): Promise<CtaRow[]> => {
  if (libraryIds.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT "id", "library_id", "artist_name", "track_title", "track_position",
           "track_artist_link_method", "track_artist_id", "track_artist_link_confidence"
    FROM ${COMPILATION_TRACK_ARTIST_TABLE}
    WHERE "library_id" = ANY(${intArrayLiteral(libraryIds)}::int[])
  `)) as unknown as CtaRow[];
  return rows ?? [];
};

/**
 * Batched local artist-name resolution (mirrors the fold_artist_name
 * singleton-match convention in `jobs/library-etl/job.ts` /
 * `jobs/concerts-artist-resolver/query.ts`, without genre/code-letters
 * scoping — a track credit carries neither). One query for every distinct
 * `resolved_artist_name` in the page rather than one per entry. A name that
 * matches zero or 2+ `artists` rows under the fold resolves to `null` —
 * conservative singleton-only writes, same convention as the concerts
 * resolver's `ambiguous` outcome.
 */
/**
 * Same bind-parameter budget as `WRITE_CHUNK_SIZE` below, one parameter per
 * name: 1,000 names/statement stays far under Postgres's 65,535-parameter
 * ceiling even if an operator raises `VA_BATCH_SIZE` to the LML cap.
 */
const NAME_CHUNK_SIZE = 1000;

const resolveArtistIdsByNames = async (names: string[]): Promise<Map<string, number | null>> => {
  const result = new Map<string, number | null>(names.map((n) => [n, null]));
  if (names.length === 0) return result;
  for (let i = 0; i < names.length; i += NAME_CHUNK_SIZE) {
    await resolveArtistIdChunk(names.slice(i, i + NAME_CHUNK_SIZE), result);
  }
  return result;
};

const resolveArtistIdChunk = async (names: string[], result: Map<string, number | null>): Promise<void> => {
  const nameValues = names.map((n) => sql`(${n}::text)`);
  const matches = (await db.execute(sql`
    SELECT v."input_name" AS input_name, a."id" AS artist_id
    FROM (VALUES ${sql.join(nameValues, sql`, `)}) AS v("input_name")
    JOIN ${ARTISTS_TABLE} a ON ${FOLD_ARTIST_NAME_FN}(a."artist_name") = ${FOLD_ARTIST_NAME_FN}(v."input_name")
  `)) as unknown as { input_name: string; artist_id: number }[];

  const idsByName = new Map<string, number[]>();
  for (const row of matches ?? []) {
    const ids = idsByName.get(row.input_name) ?? [];
    ids.push(row.artist_id);
    idsByName.set(row.input_name, ids);
  }
  for (const [name, ids] of idsByName) {
    result.set(name, ids.length === 1 ? ids[0] : null);
  }
};

/**
 * Rows queued for the batched UPDATE below. `position` is `null` when the
 * position rider doesn't apply (CTA already has one, or the offer was
 * ambiguous) — the UPDATE's `COALESCE(v.position, cta."track_position")`
 * treats that as "leave the existing position alone."
 */
type CompilationWriteRow = {
  ctaId: number;
  trackArtistId: number | null;
  confidence: number | null;
  position: string | null;
};

/**
 * Bulk-update-playbook batch cap (`docs/bulk-update-playbook.md`): each row
 * in the VALUES join binds 4 parameters, and Postgres caps a single
 * statement at 65535 bind parameters. S0/#1989 measured a max of 2,364
 * credits on a single V/A release, so a pathological page could otherwise
 * approach that ceiling — 500 rows/statement (2,000 params) keeps every
 * chunk far under it regardless of page composition.
 */
const WRITE_CHUNK_SIZE = 500;

/** `compilation_track_artist.track_position` is varchar(20) — see schema.ts. */
const CTA_TRACK_POSITION_MAX_LENGTH = 20;

/** Echo-gap warn floor: below this many misses a page is ordinary noise, not a divergence signal. */
const CTA_MATCH_GAP_WARN_MIN = 10;

/**
 * One page-level, chunked UPDATE via a `VALUES` join (the house pattern for
 * a batched write — see `streaming-url-remediation`/`artist-unicode-dedup`)
 * rather than one `UPDATE` per CTA row: at S0's measured mean of 56
 * credits/release, a 100-release `va` page is ~5,600 sequential round-trips
 * without this. `RETURNING "id"` reports the ACTUAL row count the
 * `IS DISTINCT FROM` guard let through, not just rows attempted — so a
 * no-op re-drain's `rows_written` is honestly 0, not the queued count.
 */
const applyCompilationWrites = async (
  rows: CompilationWriteRow[]
): Promise<{ written: number; returnedIds: Set<number> }> => {
  let written = 0;
  const returnedIds = new Set<number>();
  for (let i = 0; i < rows.length; i += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + WRITE_CHUNK_SIZE);
    const values = chunk.map(
      (r) => sql`(${r.ctaId}::int, ${r.trackArtistId}::int, ${r.confidence}::real, ${r.position}::text)`
    );
    const returned = (await db.execute(sql`
      UPDATE ${COMPILATION_TRACK_ARTIST_TABLE} AS cta
      SET
        "track_artist_id" = v.track_artist_id,
        "track_artist_link_confidence" = v.confidence,
        "track_artist_link_method" = 'lml_backfill',
        "track_position" = COALESCE(v.position, cta."track_position")
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, track_artist_id, confidence, position)
      WHERE cta."id" = v.id
        AND (
          cta."track_artist_id" IS DISTINCT FROM v.track_artist_id
          OR cta."track_artist_link_confidence" IS DISTINCT FROM v.confidence
          OR cta."track_artist_link_method" IS DISTINCT FROM 'lml_backfill'
          OR cta."track_position" IS DISTINCT FROM COALESCE(v.position, cta."track_position")
        )
      RETURNING cta."id"
    `)) as unknown as { id: number }[];
    for (const row of returned ?? []) returnedIds.add(row.id);
    written += (returned ?? []).length;
  }
  return { written, returnedIds };
};

/**
 * BS#1991: pair the batched write with an `ANALYZE` per the bulk-update
 * playbook, called once per drain (not per page) from `job.ts` — `ANALYZE`
 * cannot run inside a transaction and is wasted work to repeat every batch.
 */
export const analyzeCompilationTrackArtist = async (): Promise<void> => {
  await db.execute(sql`ANALYZE ${COMPILATION_TRACK_ARTIST_TABLE}`);
};

/**
 * `compilation_track_artist.track_artist_link_confidence` is `float4`
 * (Postgres `real`). A value round-tripped through that column and read back
 * through postgres-js's float8 lens differs in the digits float4 cannot
 * represent, so `buildWriteRow`'s unchanged-row prefilter must compare both
 * sides through the same float32 quantization or a genuinely-unchanged row
 * reads as changed.
 */
const float4 = (x: number | null): number | null => (x === null ? null : Math.fround(x));

/**
 * Per-row decision logic for a single CTA-matched, librarian-cleared
 * survivor (#2050, extracted from `writeCompilationTracks`): the last-entry
 * pick, the confidence range guard, the track-position rider, and the
 * app-side unchanged-row prefilter. Mutates `outcome`'s skip/ambiguous
 * counters for whichever disposition it reaches along the way.
 *
 * Returns the row to queue for the batched UPDATE, or `null` when the row is
 * unchanged from what `compilation_track_artist` already carries.
 *
 * **Load-bearing:** the `null` return is not an optimization. Before BS#2054
 * (migration 0143), the `0138` watermark trigger on `compilation_track_artist`
 * was `FOR EACH STATEMENT` and fired on `UPDATE 0` regardless of which column
 * the statement named, so an unchanged row reaching the batched UPDATE
 * advanced `library_watermark` for a change no export surfaces. As of 0143
 * the trigger's `UPDATE OF` list excludes all four columns this function
 * writes (`track_artist_id`, `track_artist_link_confidence`,
 * `track_artist_link_method`, `track_position`), so that specific hazard is
 * now structurally closed independent of this prefilter — see migration
 * 0143's header for the column-set derivation. The `null` return stays
 * load-bearing for two reasons that survive 0143: it avoids issuing a wasted
 * round-trip/lock for a row that changes nothing, and it is the only thing
 * that would protect a FUTURE write this function starts making to a column
 * the export does read. See `applyCompilationWrites`'s docstring for the
 * SQL-level `IS DISTINCT FROM` guard this prefilter backstops (and cannot be
 * replaced by, since that guard alone doesn't prevent the statement from
 * being issued in the first place).
 *
 * **Preconditions (unchecked — caller's responsibility):** `entries` must be
 * non-empty (`entries[entries.length - 1]` is read unconditionally) and
 * every entry's `resolved_artist_name` must be non-null (it's looked up
 * directly in `artistIdByName`). Both hold structurally for `writeCompilationTracks`'s
 * `survivors` list — entries with a null `resolved_artist_name` are filtered
 * out before grouping, and a key only reaches `entriesByKey` via a `push`, so
 * the bucket is never empty — but neither is enforced here, since this
 * function was extracted from an inline loop where both were already
 * guaranteed by the caller; see #2050.
 */
export const buildWriteRow = (
  ctaRow: CtaRow,
  entries: BulkResolveTrackEntry[],
  artistIdByName: Map<string, number | null>,
  outcome: CompilationWriteOutcome
): CompilationWriteRow | null => {
  // Multiple entries at the same key: identity write uses the last one
  // (an LML echo duplicate at this key is a data-quality edge case, not
  // something this job can fully disambiguate) — the position write is
  // what's genuinely ambiguous, and is handled separately below.
  const entry = entries[entries.length - 1];
  const trackArtistId = artistIdByName.get(entry.resolved_artist_name as string) ?? null;
  if (trackArtistId === null) outcome.rows_skipped_no_catalog_artist += 1;

  // `track_artist_link_confidence` carries `CHECK (BETWEEN 0 AND 1)`
  // (migration 0140). A single out-of-range value from LML must not abort
  // the whole page's batched UPDATE — null it out (a legal value; the
  // constraint is nullable) and log, mirroring `writeSingleArtist`'s own
  // defense against its sibling `library_identity_source` constraint.
  let confidence = entry.confidence;
  if (confidence !== null && (confidence < 0 || confidence > 1)) {
    log(
      'warn',
      'compilation_confidence_out_of_range',
      `CTA row ${ctaRow.id} (library_id=${ctaRow.library_id}) got an out-of-range confidence ${confidence} from LML; writing NULL instead`,
      { cta_id: ctaRow.id, library_id: ctaRow.library_id, confidence }
    );
    confidence = null;
  }

  let newPosition: string | null = null;
  if (ctaRow.track_position === null) {
    const distinctPositions = [...new Set(entries.map((e) => e.track_position).filter((p) => p !== null))];
    if (distinctPositions.length === 1) {
      const offered = distinctPositions[0];
      // `track_position` is varchar(20) (schema.ts) but the wire field is
      // an unbounded string (LML's store is TEXT) — an over-long value
      // sent verbatim raises 22001 and aborts the whole chunk, turning
      // the page into a permanent retry loop. Same defense as the
      // confidence guard above: null it and log; the identity write is
      // unaffected.
      if (offered.length > CTA_TRACK_POSITION_MAX_LENGTH) {
        log(
          'warn',
          'compilation_position_too_long',
          `CTA row ${ctaRow.id} (library_id=${ctaRow.library_id}) got a ${offered.length}-char track_position from LML (varchar(${CTA_TRACK_POSITION_MAX_LENGTH}) column); position left unset`,
          { cta_id: ctaRow.id, library_id: ctaRow.library_id, position_length: offered.length }
        );
      } else {
        newPosition = offered;
      }
    } else if (distinctPositions.length > 1) {
      outcome.position_rows_skipped_ambiguous += 1;
      log(
        'warn',
        'compilation_position_ambiguous',
        `CTA row ${ctaRow.id} (library_id=${ctaRow.library_id}) has ${distinctPositions.length} distinct track_position values offered at the same (artist_name, track_title) key; position left unset`,
        { cta_id: ctaRow.id, library_id: ctaRow.library_id, distinct_positions: distinctPositions.length }
      );
    }
  }

  // App-side unchanged check (belt) ahead of the SQL `IS DISTINCT FROM`
  // (braces): an unchanged row must not even be queued, so a fully-unchanged
  // page issues no UPDATE statement at all. Pre-BS#2054 that was what kept a
  // no-op re-drain from advancing `library_watermark`; as of migration 0143
  // the trigger's `UPDATE OF` list excludes every column this function
  // writes, so the check now earns its place on the two grounds that survive
  // 0143 — no wasted round-trip/lock, and cover for a future write to a
  // column the export reads. See this function's docstring.
  // Confidence compares through Math.fround because the column is float4:
  // the stored value read back through a float8 lens differs from the wire
  // float8 in digits float4 cannot represent.
  const unchanged =
    (ctaRow.track_artist_id ?? null) === trackArtistId &&
    float4(ctaRow.track_artist_link_confidence ?? null) === float4(confidence) &&
    (ctaRow.track_artist_link_method ?? null) === 'lml_backfill' &&
    newPosition === null;
  if (unchanged) {
    outcome.rows_skipped_unchanged += 1;
    return null;
  }

  return { ctaId: ctaRow.id, trackArtistId, confidence, position: newPosition };
};

export const writeCompilationTracks = async (
  results: Extract<BulkResolveResult, { kind: 'compilation' }>[]
): Promise<CompilationWriteOutcome> => {
  const outcome = emptyCompilationWriteOutcome();
  if (results.length === 0) return outcome;

  const ctaRows = await fetchCtaRowsForLibraries(results.map((r) => r.library_id));
  const ctaByKey = new Map<string, CtaRow>();
  for (const row of ctaRows) {
    ctaByKey.set(ctaKey(row.library_id, row.artist_name, row.track_title), row);
  }

  // Group track entries by their CTA join key. Two+ entries at the same key
  // is the position-ambiguity case (#801 D7): CTA has one row per (library,
  // artist_name, track_title), so distinct positions offered for the same
  // key cannot all be written.
  const entriesByKey = new Map<string, BulkResolveTrackEntry[]>();
  for (const result of results) {
    for (const entry of result.tracks ?? []) {
      // A "miss" — LML's matcher could not identify who performed this
      // track. No BS write; NULL track_artist_id already means this.
      // Deliberately excluded from the #801 D7 position rider too: a
      // position-only write under the single-statement shape below would
      // also stamp `track_artist_link_method = 'lml_backfill'` on a row
      // with no artist verdict, misrepresenting provenance. Recoverable
      // positions on missed tracks wait for a verdict on a later re-drain.
      if (entry.resolved_artist_name === null) continue;
      const key = ctaKey(result.library_id, entry.artist_name, entry.track_title);
      const bucket = entriesByKey.get(key) ?? [];
      bucket.push(entry);
      entriesByKey.set(key, bucket);
    }
  }

  // Pass 1 — survivors: CTA-matched and past librarian precedence. Artist
  // names resolve only for these, so a page dominated by echo misses (the
  // non_va steady state) doesn't resolve names it will discard.
  const survivors: { ctaRow: CtaRow; entries: BulkResolveTrackEntry[] }[] = [];
  for (const [key, entries] of entriesByKey) {
    const ctaRow = ctaByKey.get(key);
    if (!ctaRow) {
      outcome.rows_skipped_no_cta_match += 1;
      continue;
    }
    // Librarian precedence: a librarian-entered link is never overwritten by
    // a backfill pass, regardless of what LML now thinks.
    if (ctaRow.track_artist_link_method === 'librarian') {
      outcome.rows_skipped_librarian += 1;
      continue;
    }
    survivors.push({ ctaRow, entries });
  }

  // A page-dominating echo-match gap is a join-key divergence signal
  // (library.db's CTA export vs this table drifting on trimming/case/
  // mojibake), not ordinary misses — without this warn it is
  // indistinguishable from "LML matched nothing" and can silently no-op the
  // whole cohort.
  if (
    outcome.rows_skipped_no_cta_match >= CTA_MATCH_GAP_WARN_MIN &&
    outcome.rows_skipped_no_cta_match * 2 >= entriesByKey.size
  ) {
    log(
      'warn',
      'compilation_cta_match_gap',
      `${outcome.rows_skipped_no_cta_match} of ${entriesByKey.size} track-entry keys matched no compilation_track_artist row — possible (artist_name, track_title) echo divergence`,
      { rows_skipped_no_cta_match: outcome.rows_skipped_no_cta_match, entry_keys: entriesByKey.size }
    );
  }

  const distinctNames = [...new Set(survivors.flatMap((s) => s.entries.map((e) => e.resolved_artist_name as string)))];
  const artistIdByName = await resolveArtistIdsByNames(distinctNames);

  const writeRows: CompilationWriteRow[] = [];

  for (const { ctaRow, entries } of survivors) {
    const writeRow = buildWriteRow(ctaRow, entries, artistIdByName, outcome);
    if (writeRow) writeRows.push(writeRow);
  }

  const { written, returnedIds } = await applyCompilationWrites(writeRows);
  outcome.rows_written = written;
  // Positions count only where the UPDATE actually landed (RETURNING), so a
  // guard-filtered row doesn't over-report.
  outcome.position_rows_written = writeRows.filter((r) => r.position !== null && returnedIds.has(r.ctaId)).length;

  return outcome;
};
