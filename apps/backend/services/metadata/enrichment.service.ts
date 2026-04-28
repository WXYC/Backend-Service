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
import { eq } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import { fetchMetadata } from './metadata.service.js';

export interface EnrichmentInput {
  flowsheetId: number;
  artistName: string;
  albumId?: number;
  artistId?: number;
  albumTitle?: string;
  trackTitle?: string;
}

export function fireAndForgetMetadataForRow(input: EnrichmentInput): void {
  fetchMetadata({
    albumId: input.albumId,
    artistId: input.artistId,
    artistName: input.artistName,
    albumTitle: input.albumTitle,
    trackTitle: input.trackTitle,
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
