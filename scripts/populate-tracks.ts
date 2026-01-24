#!/usr/bin/env npx ts-node

/**
 * Populate tracks cache from Discogs.
 *
 * Fetches tracklists for rotation albums and recently-played albums,
 * caching them in the tracks table for song title search.
 *
 * Usage:
 *   npx dotenvx run -- npx ts-node scripts/populate-tracks.ts
 *   # or add to package.json scripts:
 *   npm run populate-tracks
 *
 * Options:
 *   --rotation-only   Only fetch tracks for rotation albums
 *   --recent-only     Only fetch tracks for recently-played albums
 *   --limit N         Limit to N albums (for testing)
 *   --dry-run         Show what would be fetched without making API calls
 */

import { db } from '../shared/database/src/client.js';
import {
  fetchAndCacheTracksForAlbum,
  getRotationAlbumsWithoutTracks,
  getRecentlyPlayedAlbumsWithoutTracks,
} from '../apps/backend/services/tracks.service.js';

const RATE_LIMIT_DELAY_MS = 1000; // 1 request per second to respect Discogs limits

interface PopulateOptions {
  rotationOnly: boolean;
  recentOnly: boolean;
  limit: number;
  dryRun: boolean;
}

function parseArgs(): PopulateOptions {
  const args = process.argv.slice(2);
  return {
    rotationOnly: args.includes('--rotation-only'),
    recentOnly: args.includes('--recent-only'),
    limit: parseInt(args.find((a, i) => args[i - 1] === '--limit') || '0', 10),
    dryRun: args.includes('--dry-run'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function populateTracks(options: PopulateOptions): Promise<void> {
  console.log('🎵 Track Population Script');
  console.log('==========================\n');

  if (options.dryRun) {
    console.log('⚠️  DRY RUN MODE - No API calls will be made\n');
  }

  let rotationAlbums: Array<{ album_id: number; artist_name: string; album_title: string }> = [];
  let recentAlbums: Array<{ album_id: number; artist_name: string; album_title: string }> = [];

  // Fetch rotation albums without cached tracks
  if (!options.recentOnly) {
    console.log('📀 Fetching rotation albums without cached tracks...');
    rotationAlbums = await getRotationAlbumsWithoutTracks();
    console.log(`   Found ${rotationAlbums.length} rotation albums to process\n`);
  }

  // Fetch recently-played albums without cached tracks
  if (!options.rotationOnly) {
    console.log('📻 Fetching recently-played albums without cached tracks...');
    recentAlbums = await getRecentlyPlayedAlbumsWithoutTracks();
    // Filter out albums already in rotation list
    const rotationIds = new Set(rotationAlbums.map((a) => a.album_id));
    recentAlbums = recentAlbums.filter((a) => !rotationIds.has(a.album_id));
    console.log(`   Found ${recentAlbums.length} recent albums to process\n`);
  }

  // Combine and optionally limit
  let allAlbums = [...rotationAlbums, ...recentAlbums];
  if (options.limit > 0) {
    allAlbums = allAlbums.slice(0, options.limit);
    console.log(`⚙️  Limiting to ${options.limit} albums\n`);
  }

  if (allAlbums.length === 0) {
    console.log('✅ No albums need track caching!');
    return;
  }

  console.log(`🚀 Processing ${allAlbums.length} albums...\n`);

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < allAlbums.length; i++) {
    const album = allAlbums[i];
    const progress = `[${i + 1}/${allAlbums.length}]`;

    if (options.dryRun) {
      console.log(`${progress} Would fetch: ${album.artist_name} - ${album.album_title}`);
      continue;
    }

    try {
      console.log(`${progress} Fetching: ${album.artist_name} - ${album.album_title}`);

      const tracks = await fetchAndCacheTracksForAlbum(
        album.album_id,
        album.artist_name,
        album.album_title
      );

      if (tracks.length > 0) {
        console.log(`   ✅ Cached ${tracks.length} tracks`);
        successCount++;
      } else {
        console.log(`   ⚠️  No tracks found on Discogs`);
        skippedCount++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`   ❌ Error: ${message}`);
      errorCount++;
    }

    // Rate limiting - wait before next request
    if (i < allAlbums.length - 1 && !options.dryRun) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log('\n==========================');
  console.log('📊 Summary:');
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ⚠️  Skipped: ${skippedCount}`);
  console.log(`   ❌ Errors:  ${errorCount}`);
  console.log('==========================\n');
}

// Main entry point
const options = parseArgs();

populateTracks(options)
  .then(() => {
    console.log('🎵 Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
