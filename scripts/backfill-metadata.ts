/**
 * Backfill metadata for recent flowsheet entries missing artwork.
 *
 * Fetches metadata from LML for the most recent 1000 track entries that have
 * null artwork_url, then updates each row with the full metadata payload.
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

  const entries = await db
    .select({
      id: flowsheet.id,
      artist_name: flowsheet.artist_name,
      album_title: flowsheet.album_title,
      track_title: flowsheet.track_title,
    })
    .from(flowsheet)
    .where(
      and(
        isNull(flowsheet.artwork_url),
        isNotNull(flowsheet.artist_name),
        eq(flowsheet.entry_type, 'track')
      )
    )
    .orderBy(desc(flowsheet.id))
    .limit(LIMIT);

  console.log(`\n📦 Found ${entries.length} entries to backfill.\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const metadata = await fetchMetadata({
        artistName: entry.artist_name!,
        albumTitle: entry.album_title ?? undefined,
        trackTitle: entry.track_title ?? undefined,
      });

      if (!metadata?.album?.artworkUrl) {
        skipped++;
        console.log(`   ⏭  #${entry.id} "${entry.artist_name}" — no artwork found`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`   🔍 #${entry.id} "${entry.artist_name}" — would set artwork_url = ${metadata.album.artworkUrl}`);
      } else {
        await db
          .update(flowsheet)
          .set({
            artwork_url: metadata.album.artworkUrl ?? null,
            discogs_url: metadata.album.discogsUrl ?? null,
            release_year: metadata.album.releaseYear ?? null,
            spotify_url: metadata.album.spotifyUrl ?? null,
            apple_music_url: metadata.album.appleMusicUrl ?? null,
            youtube_music_url: metadata.album.youtubeMusicUrl ?? null,
            bandcamp_url: metadata.album.bandcampUrl ?? null,
            soundcloud_url: metadata.album.soundcloudUrl ?? null,
            artist_bio: metadata.artist?.bio ?? null,
            artist_wikipedia_url: metadata.artist?.wikipediaUrl ?? null,
          })
          .where(eq(flowsheet.id, entry.id));

        console.log(`   ✅ #${entry.id} "${entry.artist_name}" — ${metadata.album.artworkUrl}`);
      }
      updated++;
    } catch (err) {
      failed++;
      console.error(`   ❌ #${entry.id} "${entry.artist_name}" — ${(err as Error).message}`);
    }
  }

  console.log('\n📊 Backfill complete:');
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped} (no artwork found)`);
  console.log(`   Failed:  ${failed}`);

  await closeDatabaseConnection();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
