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
 */
import * as Sentry from '@sentry/node';
import { eq, sql } from 'drizzle-orm';
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

export function fireAndForgetMetadataForRow(input: EnrichmentInput): void {
  fetchMetadata({
    albumId: input.albumId,
    artistId: input.artistId,
    artistName: input.artistName,
    albumTitle: input.albumTitle ?? undefined,
    trackTitle: input.trackTitle ?? undefined,
  })
    .then(async (metadata) => {
      if (!metadata) return;
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
        .where(eq(flowsheet.id, input.flowsheetId));
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
}
