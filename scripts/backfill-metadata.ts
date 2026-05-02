/**
 * Backfill metadata for recent flowsheet entries missing enrichment.
 *
 * Mirrors the runtime path (`apps/backend/services/metadata/enrichment.service.ts`)
 * exactly: every row passing the WHERE filter gets an UPDATE, including
 * rows where LML returned no artwork. `metadata.service.ts` always fills in
 * YouTube Music / Bandcamp / SoundCloud search-URL fallbacks regardless of
 * whether LML found a match, so iOS / dj-site at least get a "search for
 * this on $service" affordance for the long tail of releases LML can't pin.
 *
 * Idempotency: the WHERE filter excludes rows that already have the
 * search-URL fallback populated (`bandcamp_url IS NULL`). Re-runs naturally
 * skip rows touched by any prior enrichment, regardless of artwork status.
 *
 * Usage:
 *   dotenvx run -f .env -- npx tsx scripts/backfill-metadata.ts
 *
 * Options (env vars):
 *   BACKFILL_LIMIT    — number of entries to backfill (default 1000)
 *   BACKFILL_DRY_RUN  — set "true" to preview without updating (default false)
 */

import { config } from 'dotenv';
config();

import { db, closeDatabaseConnection } from '../shared/database/src/client.js';
import { flowsheet } from '../shared/database/src/schema.js';
import { fetchMetadata } from '../apps/backend/services/metadata/metadata.service.js';
import { eq, and, isNull, isNotNull, desc } from 'drizzle-orm';

const LIMIT = parseInt(process.env.BACKFILL_LIMIT ?? '1000', 10);
const DRY_RUN = process.env.BACKFILL_DRY_RUN === 'true';

async function main(): Promise<void> {
  if (!process.env.LIBRARY_METADATA_URL) {
    console.error('❌ LIBRARY_METADATA_URL is not set. Cannot fetch metadata.');
    process.exit(1);
  }

  console.log(`🔧 Backfill metadata from LML (${process.env.LIBRARY_METADATA_URL})`);
  console.log(`   Limit: ${LIMIT}, Dry run: ${DRY_RUN}`);

  // Filter on `bandcamp_url IS NULL` rather than `artwork_url IS NULL`.
  // Every successful enrichment — artwork or not — writes a non-null
  // bandcamp_url via the search-URL fallback in metadata.service.ts. Using
  // bandcamp_url as the "untouched" sentinel keeps re-runs idempotent: a
  // row processed by any prior run falls out of the filter regardless of
  // whether LML found artwork.
  const entries = await db
    .select({
      id: flowsheet.id,
      artist_name: flowsheet.artist_name,
      album_title: flowsheet.album_title,
      track_title: flowsheet.track_title,
    })
    .from(flowsheet)
    .where(and(isNull(flowsheet.bandcamp_url), isNotNull(flowsheet.artist_name), eq(flowsheet.entry_type, 'track')))
    .orderBy(desc(flowsheet.id))
    .limit(LIMIT);

  console.log(`\n📦 Found ${entries.length} entries to backfill.\n`);

  let withArtwork = 0;
  let searchUrlsOnly = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const metadata = await fetchMetadata({
        artistName: entry.artist_name!,
        albumTitle: entry.album_title ?? undefined,
        trackTitle: entry.track_title ?? undefined,
      });

      // `fetchMetadata` returns null only when LIBRARY_METADATA_URL is
      // missing (we've already guarded that at startup). Otherwise it
      // always returns a non-null result — search-URL fallbacks fill in
      // whenever LML doesn't return artwork.
      if (!metadata) {
        failed++;
        console.error(`   ❌ #${entry.id} "${entry.artist_name}" — fetchMetadata returned null`);
        continue;
      }

      const hasArtwork = !!metadata.album?.artworkUrl;
      const summary = hasArtwork ? `${metadata.album!.artworkUrl}` : '(no artwork; search URLs only)';

      if (DRY_RUN) {
        console.log(`   🔍 #${entry.id} "${entry.artist_name}" — would update — ${summary}`);
      } else {
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
          .where(eq(flowsheet.id, entry.id));

        console.log(`   ${hasArtwork ? '✅' : '🔗'} #${entry.id} "${entry.artist_name}" — ${summary}`);
      }
      if (hasArtwork) withArtwork++;
      else searchUrlsOnly++;
    } catch (err) {
      failed++;
      console.error(`   ❌ #${entry.id} "${entry.artist_name}" — ${(err as Error).message}`);
    }
  }

  console.log('\n📊 Backfill complete:');
  console.log(`   With artwork:     ${withArtwork}`);
  console.log(`   Search URLs only: ${searchUrlsOnly}`);
  console.log(`   Failed:           ${failed}`);

  await closeDatabaseConnection();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
