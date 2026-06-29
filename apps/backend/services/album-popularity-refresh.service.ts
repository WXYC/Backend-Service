/**
 * Periodic rebuild of the `album_popularity` table — the attribution-corrected,
 * master-collapsed catalog popularity signal (BS#1486 Phase-2 Track 2 / #1492).
 *
 * Unlike `album_plays` (a linked-only, per-pressing materialized view refreshed
 * with `REFRESH MATERIALIZED VIEW CONCURRENTLY`), `album_popularity` collapses
 * the pressings/formats that resolve to one Discogs master into a single
 * logical-album count AND folds in the free-text/unlinked plays Track 1
 * resolved to that same master/release (the resolved subset of the ~43%
 * free-text tail; release-only and unresolved rows keep their own key). It is a
 * plain TABLE, not an MV, because the
 * free-text leg cannot be expressed as a single SQL SELECT: keying raw
 * `flowsheet` text against `flowsheet_freetext_resolution` requires the SAME
 * JS-side normalization Track 1 used to write that table (`freetextPairKey`),
 * and `normalizeAlbumTitle` has no SQL twin. So we rebuild in two legs:
 *
 *   1. LINKED leg (pure SQL). Every `flowsheet` track row with an `album_id`
 *      FK, keyed by its `library` row's logical key:
 *        - `master:<id>` / `release:<id>`  — strip the `discogs:` prefix off
 *          `library.canonical_entity_id` (already `discogs:master:<id>` for
 *          ~90% of resolved rows; see memory/the plan). This IS the collapse:
 *          every pressing sharing a master folds into one key.
 *        - `library:<id>`                   — fallback when `canonical_entity_id`
 *          IS NULL, so a played-but-unresolved row's plays are never lost.
 *      Written with `plays = linked_plays`, `freetext_plays = 0`,
 *      `representative_library_id = min(library.id)` in the group.
 *
 *   2. FREE-TEXT leg (SQL read + JS keying + UPSERT). Distinct raw
 *      `(artist_name, album_title)` of every unlinked track row with a play
 *      count, re-keyed via `freetextPairKey` to match Track 1's persisted
 *      `(norm_artist, norm_album)`, joined to the resolution's release/master,
 *      summed per logical key, then UPSERT-added onto the linked rows
 *      (`plays = linked_plays + EXCLUDED.freetext_plays`). A free-text-only key
 *      (album we play but don't own / unresolved-in-library) inserts fresh with
 *      `linked_plays = 0` and a NULL `representative_library_id`.
 *
 * The whole rebuild runs inside one transaction on a dedicated single-conn
 * client (DELETE + repopulate), so catalog-export readers see the previous
 * snapshot via MVCC until commit — never a partially-built table.
 *
 * IMPORTANT — does NOT advance `library_watermark`. Per the plan (decision 4),
 * popularity is a slow-moving signal; bumping the watermark on every refresh
 * would over-invalidate the whole catalog-export cache. The new value surfaces
 * in the export on the next incidental library write that bumps the watermark.
 * A day-scale lag is acceptable. This mirrors what `album_plays` already does.
 *
 * Per-statement timeout: like `album-plays-refresh`, the rebuild legitimately
 * exceeds the API container's `DB_STATEMENT_TIMEOUT_MS` (5s) on prod, so it
 * runs against a dedicated single-connection client with its own
 * `statement_timeout` override (`ALBUM_POPULARITY_REFRESH_TIMEOUT_MS`, default
 * 5 min). Cadence via `ALBUM_POPULARITY_REFRESH_INTERVAL_MS` (default 1 hour).
 * Last-run is recorded in `cronjob_runs` under `album-popularity-refresh`.
 *
 * Exported API mirrors `album-plays-refresh.service.ts`:
 *   startAlbumPopularityRefresh() / stopAlbumPopularityRefresh() / refreshAlbumPopularity()
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  db,
  cronjob_runs,
  album_popularity,
  flowsheet,
  library,
  flowsheet_freetext_resolution,
  createPostgresClient,
  freetextPairKey,
} from '@wxyc/database';

const JOB_NAME = 'album-popularity-refresh';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h, matching album-plays
const DEFAULT_REFRESH_TIMEOUT_MS = 5 * 60 * 1000; // 5min
const APPLICATION_NAME = 'wxyc-album-popularity-refresh';
const UPSERT_BATCH_SIZE = 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

let refreshClient: ReturnType<typeof postgres> | null = null;
let refreshDb: ReturnType<typeof drizzle> | null = null;

// -- Pure, unit-testable core -------------------------------------------------

/**
 * The logical_album_key for a free-text resolution row, or null when the row
 * resolved to neither a master nor a release (a no-match — unattributable, so
 * its plays contribute nothing). Master wins over release so every pressing
 * folds into the master key; this MUST stay identical to the linked leg's
 * `discogs:`-stripped key and to the SQL `freetext_logical_key` expression.
 */
export const freetextLogicalKey = (row: {
  discogs_master_id: number | null;
  discogs_release_id: number | null;
}): string | null => {
  if (row.discogs_master_id != null) return `master:${row.discogs_master_id}`;
  if (row.discogs_release_id != null) return `release:${row.discogs_release_id}`;
  return null;
};

export type ResolutionRow = {
  norm_artist: string;
  norm_album: string;
  discogs_master_id: number | null;
  discogs_release_id: number | null;
};

export type RawFreetextPlays = {
  artist_name: string | null;
  album_title: string | null;
  plays: number;
};

/**
 * Compose free-text play totals per logical_album_key. Pure so the keying +
 * aggregation is unit-tested against the REAL normalizers (`freetextPairKey`),
 * which is the parity contract with Track 1's persisted keys. Raw
 * `(artist, album)` pairs that don't normalize to a resolved pair are dropped.
 */
export const aggregateFreetextPlays = (
  resolutions: ResolutionRow[],
  rawPlays: RawFreetextPlays[]
): Map<string, number> => {
  // Collision-free composite key (normalized text contains spaces), matching
  // Track 1's `pairKey` JSON encoding so the join is unambiguous.
  const pairKey = (na: string, nb: string): string => JSON.stringify([na, nb]);

  // normalized (norm_artist, norm_album) -> logical_album_key
  const keyByNormPair = new Map<string, string>();
  for (const r of resolutions) {
    const lk = freetextLogicalKey(r);
    if (lk === null) continue;
    keyByNormPair.set(pairKey(r.norm_artist, r.norm_album), lk);
  }

  const playsByLogicalKey = new Map<string, number>();
  for (const p of rawPlays) {
    const { norm_artist, norm_album } = freetextPairKey(p.artist_name, p.album_title);
    const lk = keyByNormPair.get(pairKey(norm_artist, norm_album));
    if (lk === undefined) continue; // raw pair has no resolved match
    playsByLogicalKey.set(lk, (playsByLogicalKey.get(lk) ?? 0) + p.plays);
  }
  return playsByLogicalKey;
};

// -- Dedicated connection (mirrors album-plays-refresh) -----------------------

function getRefreshDb(): ReturnType<typeof drizzle> {
  if (refreshDb !== null) return refreshDb;
  const client = createPostgresClient({
    statementTimeoutMs: readRefreshTimeoutFromEnv(),
    applicationName: APPLICATION_NAME,
    max: 1,
  });
  const handle = drizzle(client);
  refreshClient = client;
  refreshDb = handle;
  return handle;
}

// -- Refresh ------------------------------------------------------------------

/**
 * Rebuild `album_popularity` and record the completion timestamp in
 * `cronjob_runs`. The rebuild is a single transaction: DELETE, repopulate the
 * linked leg in SQL, then UPSERT the free-text leg from JS-aggregated totals.
 */
export async function refreshAlbumPopularity(): Promise<void> {
  const refreshDbInstance = getRefreshDb();

  // REPEATABLE READ so every statement in the rebuild reads ONE MVCC snapshot.
  // The two legs partition `flowsheet` by `album_id`: the free-text rawPlays
  // SELECT counts `album_id IS NULL` rows, the linked INSERT...SELECT counts
  // `album_id IS NOT NULL` rows. Under READ COMMITTED each statement re-snapshots,
  // so a concurrent enrichment-worker link (`album_id` NULL -> set) committing in
  // the window between them would have the play counted by BOTH legs (a
  // double-count) — or a library delete (`album_id` set -> NULL via ON DELETE SET
  // NULL) would drop it from both (an under-count). One snapshot makes the
  // partition exact. The tx writes only `album_popularity` (single max:1 writer,
  // no concurrent writer), so the stricter level raises no serialization error.
  await refreshDbInstance.transaction(
    async (tx) => {
      // Read both free-text inputs inside the tx — one consistent snapshot.
      const resolutions = (await tx.execute(sql`
      SELECT "norm_artist", "norm_album", "discogs_master_id", "discogs_release_id"
      FROM ${flowsheet_freetext_resolution}
      WHERE "discogs_master_id" IS NOT NULL OR "discogs_release_id" IS NOT NULL
    `)) as unknown as ResolutionRow[];

      const rawPlays = (await tx.execute(sql`
      SELECT "artist_name", "album_title", count(*)::int AS "plays"
      FROM ${flowsheet}
      WHERE "entry_type" = 'track'
        AND "album_id" IS NULL
        AND "artist_name" IS NOT NULL
        AND "album_title" IS NOT NULL
      GROUP BY "artist_name", "album_title"
    `)) as unknown as RawFreetextPlays[];

      const freetextByKey = aggregateFreetextPlays(resolutions, rawPlays);

      // Rebuild from scratch each cycle (full recompute, like the MV refresh).
      await tx.execute(sql`DELETE FROM ${album_popularity}`);

      // LINKED leg: one row per logical key, summing pressings that share a
      // master. `library:<id>` fallback keeps unresolved-but-played rows.
      await tx.execute(sql`
      INSERT INTO ${album_popularity}
        ("logical_album_key", "plays", "linked_plays", "freetext_plays", "representative_library_id")
      SELECT "key", count(*)::int, count(*)::int, 0, min("library_id")
      FROM (
        SELECT
          CASE
            -- 'discogs:master:<id>' / 'discogs:release:<id>' -> 'master:<id>' /
            -- 'release:<id>' (the ~90%/~10% resolved split). Strip only the
            -- 'discogs:' namespace; the master/release segment IS the key.
            WHEN l."canonical_entity_id" LIKE 'discogs:%'
              THEN substring(l."canonical_entity_id" from 'discogs:(.*)')
            -- Defensive: a non-'discogs:' scheme should not exist today, but if
            -- one appears use it verbatim rather than letting substring() return
            -- NULL and violate the NOT NULL primary key.
            WHEN l."canonical_entity_id" IS NOT NULL
              THEN l."canonical_entity_id"
            -- Unresolved (NULL canonical): keep the row as its own logical album
            -- so a played library row's plays are never lost.
            ELSE 'library:' || l."id"::text
          END AS "key",
          l."id" AS "library_id"
        FROM ${flowsheet} f
        JOIN ${library} l ON l."id" = f."album_id"
        WHERE f."entry_type" = 'track'
      ) t
      GROUP BY "key"
    `);

      // FREE-TEXT leg: add onto linked rows, or insert fresh free-text-only keys.
      const entries = [...freetextByKey.entries()];
      for (let i = 0; i < entries.length; i += UPSERT_BATCH_SIZE) {
        const batch = entries.slice(i, i + UPSERT_BATCH_SIZE);
        await tx
          .insert(album_popularity)
          .values(
            batch.map(([logical_album_key, freetext_plays]) => ({
              logical_album_key,
              plays: freetext_plays,
              linked_plays: 0,
              freetext_plays,
              representative_library_id: null,
            }))
          )
          .onConflictDoUpdate({
            target: album_popularity.logical_album_key,
            set: {
              freetext_plays: sql`excluded."freetext_plays"`,
              // plays = existing linked_plays + the new free-text plays.
              plays: sql`${album_popularity.linked_plays} + excluded."freetext_plays"`,
            },
          });
      }
    },
    { isolationLevel: 'repeatable read' }
  );

  const now = new Date();
  await db
    .insert(cronjob_runs)
    .values({ job_name: JOB_NAME, last_run: now })
    .onConflictDoUpdate({ target: cronjob_runs.job_name, set: { last_run: now } });
}

// -- Lifecycle (mirrors album-plays-refresh) ----------------------------------

export function startAlbumPopularityRefresh(intervalMs: number = readIntervalFromEnv()): void {
  if (timer !== null) return;
  stopped = false;
  scheduleNext(intervalMs);
}

export function stopAlbumPopularityRefresh(): void {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (refreshClient !== null) {
    refreshClient.end().catch((err) => console.error('[album-popularity-refresh] dedicated client end() failed:', err));
    refreshClient = null;
    refreshDb = null;
  }
}

function scheduleNext(intervalMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    void runOneRefreshAndReschedule(intervalMs);
  }, intervalMs);
  timer.unref?.();
}

async function runOneRefreshAndReschedule(intervalMs: number): Promise<void> {
  try {
    await refreshAlbumPopularity();
  } catch (err) {
    console.error('[album-popularity-refresh] refresh failed:', err);
  }
  if (!stopped) scheduleNext(intervalMs);
}

function readIntervalFromEnv(): number {
  const raw = process.env.ALBUM_POPULARITY_REFRESH_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function readRefreshTimeoutFromEnv(): number {
  const raw = process.env.ALBUM_POPULARITY_REFRESH_TIMEOUT_MS;
  if (!raw) return DEFAULT_REFRESH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_TIMEOUT_MS;
}

// Exposed for unit tests.
export const __TEST_ONLY__ = {
  JOB_NAME,
  DEFAULT_INTERVAL_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  APPLICATION_NAME,
  UPSERT_BATCH_SIZE,
  hasPendingTimer: (): boolean => timer !== null,
  hasDedicatedClient: (): boolean => refreshClient !== null,
};
