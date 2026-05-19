/**
 * Fire-and-forget flowsheet metadata enrichment.
 *
 * Called after a track row is inserted or upserted on either path that lands
 * in `flowsheet`: the dj-site `addEntry` controller and the tubafrenzy
 * webhook receiver. Fetches metadata from LML and writes the 10-column
 * payload back onto the row.
 *
 * The promise is intentionally not awaited by callers — enrichment must
 * never block the HTTP response. Errors are logged and reported to Sentry
 * under `subsystem='metadata'`, never thrown.
 *
 * To make process exits observable (BS#905), each fire-and-forget promise
 * registers itself in `inFlightEnrichments` and unregisters via `.finally`.
 * `drainInFlightEnrichments` is called from the SIGTERM/SIGINT shutdown path
 * in `apps/backend/app.ts` so an exiting BS gets a Sentry breadcrumb naming
 * how many enrichments were abandoned mid-flight. Post-Epic C the runtime
 * path is gone and this whole apparatus retires alongside it.
 */
import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import { fetchMetadata } from './metadata.service.js';

export interface EnrichmentInput {
  flowsheetId: number;
  artistName: string;
  albumId?: number;
  artistId?: number;
  // null is accepted because the webhook receiver's `truncate()` returns
  // `string | null`; converting to undefined at every call site is noise.
  albumTitle?: string | null;
  trackTitle?: string | null;
}

const inFlightEnrichments = new Set<Promise<unknown>>();

export function getInFlightEnrichmentCount(): number {
  return inFlightEnrichments.size;
}

/**
 * Test-only: clear the registry without awaiting any of the in-flight
 * promises. Production code must never call this — drained enrichments
 * still mutate the DB once their fetch resolves, so dropping them on the
 * floor mid-flight is exactly the bug this module avoids. The leading
 * underscore + Sentry-ignore convention keeps that intent loud.
 */
export function _resetInFlightEnrichmentsForTest(): void {
  inFlightEnrichments.clear();
}

/**
 * Wait up to `deadlineMs` for every enrichment in the snapshot taken at call
 * time to settle, then return the *current registry size* — which may
 * include promises added during the wait (a request that arrives between
 * SIGTERM and `server.close()` completing its drain can still fire enrichment
 * before the HTTP layer rejects it). The returned count is therefore a drop
 * *estimate*, not a strict count of unsettled snapshot members. That's the
 * right shape for a `level: 'warning'` Sentry signal; precision was never
 * the point.
 *
 * Never throws or rejects for individual promise rejections (they're already
 * handled via .catch). Returns 0 immediately when the registry is empty so
 * a healthy shutdown pays no setTimeout cost.
 */
export async function drainInFlightEnrichments(deadlineMs: number): Promise<number> {
  if (inFlightEnrichments.size === 0) return 0;
  const snapshot = Array.from(inFlightEnrichments);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  return inFlightEnrichments.size;
}

export function fireAndForgetMetadataForRow(input: EnrichmentInput): void {
  const promise = fetchMetadata({
    albumId: input.albumId,
    artistId: input.artistId,
    artistName: input.artistName,
    albumTitle: input.albumTitle ?? undefined,
    trackTitle: input.trackTitle ?? undefined,
  })
    .then(async (metadata) => {
      if (!metadata) return;
      // The `?? null` on the 7 non-search-URL columns nulls them on
      // no-match. Safe here because the runtime path runs at insert
      // time on fresh rows — there's nothing to overwrite. The
      // backfill (`jobs/flowsheet-metadata-backfill/enrich.ts`) takes
      // the opposite stance on no-match (preserves prior values)
      // because it runs over rows the recovery script may have
      // populated. See that file's no-match branch for the rationale;
      // if the runtime ever runs over rows with prior values
      // (e.g., a re-enrichment trigger), this side should adopt the
      // same preserve semantics.
      await db
        .update(flowsheet)
        .set({
          artwork_url: metadata.album?.artworkUrl ?? null,
          discogs_url: metadata.album?.discogsUrl ?? null,
          release_year: metadata.album?.releaseYear ?? null,
          spotify_url: metadata.album?.spotifyUrl ?? null,
          apple_music_url: metadata.album?.appleMusicUrl ?? null,
          youtube_music_url: metadata.album?.youtubeMusicUrl ?? null,
          bandcamp_url: metadata.album?.bandcampUrl ?? null,
          soundcloud_url: metadata.album?.soundcloudUrl ?? null,
          artist_bio: metadata.artist?.bio ?? null,
          artist_wikipedia_url: metadata.artist?.wikipediaUrl ?? null,
          // Stamps both LML success-with-match and LML success-no-match
          // (the `.then` only runs when fetchMetadata resolved). Transient
          // LML failures land in `.catch` below and stay retryable by the
          // recurring drift-repair sweep — see #639.
          metadata_attempt_at: sql`NOW()`,
        })
        // Mirrors the backfill's idempotency guard in
        // `jobs/flowsheet-metadata-backfill/enrich.ts` line 173. If a
        // concurrent writer (drift-repair backfill, or — until C5 — a
        // duplicate runtime call) already stamped this row, our UPDATE
        // resolves to 0 rows at row-lock granularity and the prior
        // stamp is preserved. Backfill semantics on no-match preserve
        // prior values; the runtime nulls them — so the race outcome
        // is order-sensitive. The IS NULL gate ensures only one
        // landing wins.
        .where(sql`"id" = ${input.flowsheetId} AND "metadata_attempt_at" IS NULL`);
    })
    .catch((err) => {
      console.error('[Flowsheet] Metadata fetch failed:', err);
      Sentry.captureException(err, {
        tags: { subsystem: 'metadata' },
        extra: {
          flowsheetId: input.flowsheetId,
          artistName: input.artistName,
          albumTitle: input.albumTitle,
        },
      });
    });

  inFlightEnrichments.add(promise);
  // .finally chains after the .catch above, so the registry always reaches
  // size 0 whether the fetch resolved or rejected — drain accuracy depends
  // on it. Failure to unregister would slow-leak the registry and inflate
  // the shutdown-time "dropped" count.
  void promise.finally(() => {
    inFlightEnrichments.delete(promise);
  });
}
