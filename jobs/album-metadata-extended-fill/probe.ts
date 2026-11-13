/**
 * The probe (BS#1442): fetch from LML for the first N cohort albums, write
 * nothing, and tally what a write would add. It spends Discogs quota on cache
 * misses, which is why its numbers come before the canary.
 */

import type { FillCandidate } from './cohort.js';
import type { LmlFetcher } from './fetch.js';
import * as map from './map.js';
import { checkPin, type PinLookup } from './pins.js';
import type { ArtistGate, ExtendedColumn, TooLongColumn } from './map.js';

// prettier-ignore
const OUTCOMES = ['would_fill', 'nothing_new', 'release_not_found_suspected', 'release_unanswered', 'no_release_id', 'pin_disagrees', 'pin_unanswered'] as const;
export type ProbeOutcome = (typeof OUTCOMES)[number];

export interface ProbeAlbum {
  outcome: ProbeOutcome;
  /** The missing columns this album's fetch gives a value. */
  wouldFill: ExtendedColumn[];
  gate?: ArtistGate;
  cached?: boolean;
  latencyMs?: number;
  /** Set when the artist fetch failed. */
  artistStatus?: number;
  tooLong: TooLongColumn[];
  hasWikipediaUrl: boolean;
}

/** Fetch one album's release, and its artist when the compilation gate lets
 * it, and say which missing columns would gain a value. No bio, no `bio_tokens`.
 * `pin` is the album's entry from `lookupBatchPins`; a disagreeing or
 * unanswered pin settles the album before any release fetch. */
export const probeAlbum = async (candidate: FillCandidate, lml: LmlFetcher, pin?: PinLookup): Promise<ProbeAlbum> => {
  const base = { wouldFill: [], tooLong: [], hasWikipediaUrl: candidate.has_wikipedia_url };
  const releaseId = map.parseDiscogsReleaseId(candidate.discogs_url);
  if (releaseId === undefined) {
    return { ...base, outcome: 'no_release_id' };
  }
  const pinCheck = checkPin(releaseId, pin);
  if (pinCheck !== 'proceed') {
    return { ...base, outcome: pinCheck };
  }
  const release = await lml.release(releaseId);
  if ('status' in release) {
    return { ...base, outcome: release.status === 404 ? 'release_not_found_suspected' : 'release_unanswered' };
  }
  const { columns, gate, tooLong } = map.mapRelease(release.value);
  const values: Partial<Record<ExtendedColumn, unknown>> = { ...columns };
  let artistStatus: number | undefined;
  if (columns.discogs_artist_id !== null) {
    const artist = await lml.artist(columns.discogs_artist_id);
    if ('status' in artist) {
      artistStatus = artist.status;
    } else {
      const mapped = map.mapArtist(artist.value);
      Object.assign(values, mapped.columns);
      tooLong.push(...mapped.tooLong);
    }
  }
  const wouldFill = candidate.missing.filter((c) => values[c] != null && (c !== 'bio_tokens' || candidate.has_bio));
  const outcome = wouldFill.length > 0 ? 'would_fill' : 'nothing_new';
  const { cached = false } = release.value;
  // Only a column the row is missing would have been written, so only its drop counts.
  const dropped = tooLong.filter((c) => candidate.missing.includes(c));
  return { ...base, outcome, wouldFill, gate, cached, latencyMs: release.latencyMs, artistStatus, tooLong: dropped };
};

const zeros = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Empty running totals for `addProbeAlbum`. */
export const emptyProbeTotals = () => ({
  albums: 0,
  outcomes: zeros(OUTCOMES),
  would_fill_by_column: zeros(map.EXTENDED_COLUMNS),
  gate: zeros(map.ARTIST_GATES),
  too_long: zeros(Object.keys(map.COLUMN_MAX_LENGTH) as TooLongColumn[]),
  artist: { answered: 0, not_found: 0, unanswered: 0 },
  cacheHits: 0,
  missLatenciesMs: [] as number[],
  bio_tokens_fillable: 0,
  bio_tokens_fillable_with_wikipedia_url: 0,
});
export type ProbeTotals = ReturnType<typeof emptyProbeTotals>;

/** Add one probed album to the totals. Mutates and returns `totals`. */
export const addProbeAlbum = (totals: ProbeTotals, album: ProbeAlbum): ProbeTotals => {
  totals.albums += 1;
  totals.outcomes[album.outcome] += 1;
  album.wouldFill.forEach((c) => (totals.would_fill_by_column[c] += 1));
  album.tooLong.forEach((c) => (totals.too_long[c] += 1));
  if (album.gate) {
    totals.gate[album.gate] += 1;
  }
  if (album.gate === 'single') {
    const status = album.artistStatus;
    totals.artist[status === undefined ? 'answered' : status === 404 ? 'not_found' : 'unanswered'] += 1;
  }
  if (album.cached) {
    totals.cacheHits += 1;
  } else if (album.cached === false) {
    totals.missLatenciesMs.push(album.latencyMs ?? 0);
  }
  if (album.wouldFill.includes('bio_tokens')) {
    totals.bio_tokens_fillable += 1;
    totals.bio_tokens_fillable_with_wikipedia_url += album.hasWikipediaUrl ? 1 : 0;
  }
  return totals;
};

/** The probe's log payload: the totals with the cache-hit share and cache-miss latency computed. */
export const summarizeProbe = (totals: ProbeTotals) => {
  const { cacheHits, missLatenciesMs, ...rest } = totals;
  const sorted = [...missLatenciesMs].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null);
  const answered = cacheHits + sorted.length;
  return {
    ...rest,
    release_cache: {
      hits: cacheHits,
      misses: sorted.length,
      hit_share: answered > 0 ? cacheHits / answered : null,
      miss_latency_ms: { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null },
    },
  };
};
