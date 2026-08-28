/**
 * Unit tests for the BS#2295 streaming-columns drain's pure surface.
 *
 * `@wxyc/metadata` resolves to source (jest.unit.config.ts moduleNameMapper),
 * so `buildStreamingFill` is exercised against the REAL `normalizeLookup` +
 * `synthesizeSearchUrls` — the same functions `enrich.ts` writes through. That
 * matters more than it usually would here: the drain's entire correctness
 * claim is "writes what the enrichment worker would have written", and a
 * stubbed synthesizer would let that claim pass while being false.
 *
 * @see WXYC/Backend-Service#2295
 */

import { describe, it, expect } from '@jest/globals';
import {
  COHORT_COLUMNS,
  buildStreamingFill,
  cohortPredicateSql,
  computeBulkTimeoutMs,
  resolveOptions,
} from '../../../../jobs/streaming-columns-drain/job';

const FALLBACKS = { artist: 'Stereolab', album: 'Aluminum Tunes' };

/** Minimal LookupResponse shaped like LML's match branch. */
const lookupWith = (artwork: Record<string, unknown> | null) =>
  ({ results: [{ index: 0, status: 'match', artwork }] }) as never;

describe('cohortPredicateSql (BS#2295 frozen shape, one definition)', () => {
  it('requires a load-bearing column AND null on every one of the five streaming columns', () => {
    const predicate = cohortPredicateSql();
    expect(predicate).toContain('"artwork_url" IS NOT NULL OR "discogs_url" IS NOT NULL');
    for (const col of COHORT_COLUMNS) {
      expect(predicate).toContain(`"${col}" IS NULL`);
    }
  });

  it('covers exactly the five streaming columns — a sixth would silently narrow the drain', () => {
    // Pinned as a literal rather than derived from COHORT_COLUMNS: if someone
    // adds a column to that array, this fails and they have to decide whether
    // the enrichment-worker gate in precheck.ts needs the same column. The two
    // must move together or the drain and the gate disagree about "done".
    expect([...COHORT_COLUMNS]).toEqual([
      'spotify_url',
      'apple_music_url',
      'youtube_music_url',
      'bandcamp_url',
      'soundcloud_url',
    ]);
  });

  it('qualifies every column with the alias when one is given, so a JOINed enumeration is unambiguous', () => {
    const predicate = cohortPredicateSql('am');
    expect(predicate).toContain('am."artwork_url"');
    for (const col of COHORT_COLUMNS) {
      expect(predicate).toContain(`am."${col}" IS NULL`);
    }
    // No bare (unqualified) reference may survive — `library` also has an
    // `artwork_url`, so an unqualified one in the joined query is ambiguous
    // at best and reads the wrong table at worst.
    expect(predicate).not.toMatch(/(?<!am\.)"artwork_url"/);
  });
});

describe('buildStreamingFill', () => {
  it('fills the three synthesizable columns and leaves spotify/apple null when there is no lookup at all', () => {
    // The no-match / LML-threw path. This is what guarantees a drained row
    // leaves the cohort even when LML has nothing: the three search URLs come
    // from our own library text, not from LML.
    const fill = buildStreamingFill(null, FALLBACKS);
    expect(fill.youtube_music_url).toBe('https://music.youtube.com/search?q=Stereolab%20Aluminum%20Tunes');
    expect(fill.bandcamp_url).toBe('https://bandcamp.com/search?q=Stereolab%20Aluminum%20Tunes');
    expect(fill.soundcloud_url).toBe('https://soundcloud.com/search?q=Stereolab');
    expect(fill.spotify_url).toBeNull();
    expect(fill.apple_music_url).toBeNull();
  });

  it('never synthesizes a spotify or apple search URL even when LML matched but returned neither', () => {
    // BS#1184 / BS#1192. Persisting a keyword-search URL for these two would
    // launder "we could not verify a match" into a clickable button, so they
    // stay null and the proxy fills them at read time.
    const fill = buildStreamingFill(
      lookupWith({
        artwork_url: 'https://i.discogs.com/x/cover.jpg',
        release_url: 'https://www.discogs.com/release/1',
      }),
      FALLBACKS
    );
    expect(fill.spotify_url).toBeNull();
    expect(fill.apple_music_url).toBeNull();
    expect(fill.youtube_music_url).toContain('music.youtube.com/search');
  });

  it('prefers LML verified URLs over the synthesized fallbacks', () => {
    const fill = buildStreamingFill(
      lookupWith({
        artwork_url: 'https://i.discogs.com/x/cover.jpg',
        release_url: 'https://www.discogs.com/release/1',
        spotify_url: 'https://open.spotify.com/album/real',
        apple_music_url: 'https://music.apple.com/album/real',
        youtube_music_url: 'https://music.youtube.com/playlist?list=real',
        bandcamp_url: 'https://stereolab.bandcamp.com/album/aluminum-tunes',
        soundcloud_url: 'https://soundcloud.com/stereolab/real',
      }),
      FALLBACKS
    );
    expect(fill.spotify_url).toBe('https://open.spotify.com/album/real');
    expect(fill.apple_music_url).toBe('https://music.apple.com/album/real');
    expect(fill.youtube_music_url).toBe('https://music.youtube.com/playlist?list=real');
    expect(fill.bandcamp_url).toBe('https://stereolab.bandcamp.com/album/aluminum-tunes');
    expect(fill.soundcloud_url).toBe('https://soundcloud.com/stereolab/real');
  });

  it('always returns a non-null value for all three synthesizable columns, whatever LML said', () => {
    // The property the whole drain rests on: every branch leaves the cohort.
    for (const lookup of [null, lookupWith(null), lookupWith({ artwork_url: null })]) {
      const fill = buildStreamingFill(lookup as never, FALLBACKS);
      expect(fill.youtube_music_url).toBeTruthy();
      expect(fill.bandcamp_url).toBeTruthy();
      expect(fill.soundcloud_url).toBeTruthy();
    }
  });

  it('URL-encodes an artist whose name carries diacritics rather than emitting a raw non-ASCII query', () => {
    const fill = buildStreamingFill(null, { artist: 'Nilüfer Yanya', album: 'Miss Universe' });
    expect(fill.bandcamp_url).toBe('https://bandcamp.com/search?q=Nil%C3%BCfer%20Yanya%20Miss%20Universe');
  });
});

describe('resolveOptions', () => {
  it('defaults to DRY RUN — the drain never writes unless --execute is passed', () => {
    expect(resolveOptions({}, ['node', 'job.js']).execute).toBe(false);
  });

  it('opts into writes only on the explicit --execute flag', () => {
    expect(resolveOptions({}, ['node', 'job.js', '--execute']).execute).toBe(true);
  });

  it('does not treat the older sibling convention --dry-run as a request to write', () => {
    // `album-level-backfill` defaults to writing and takes `--dry-run` to opt
    // out. Someone carrying that muscle memory here must still get a dry run.
    expect(resolveOptions({}, ['node', 'job.js', '--dry-run']).execute).toBe(false);
  });

  it('reads the batch/rate/cap knobs from env and defaults maxAlbums to uncapped', () => {
    const opts = resolveOptions({ DRAIN_BULK_BATCH_SIZE: '10', DRAIN_MAX_ALBUMS: '25' }, []);
    expect(opts.batchSize).toBe(10);
    expect(opts.maxAlbums).toBe(25);
    expect(resolveOptions({}, []).maxAlbums).toBe(0);
  });
});

describe('computeBulkTimeoutMs', () => {
  it('scales with batch size and clears the LML client 30s default at the BS#1197 batch size', () => {
    expect(computeBulkTimeoutMs(5)).toBe(30_000);
    expect(computeBulkTimeoutMs(1)).toBe(10_000);
  });
});
