/**
 * One album through the extended fill (BS#1442): the pin gate, the release,
 * its artist, and the fill-null write, classified per the plan's outcome table.
 *
 * A 404 is only a suspected not-found, since LML also returns it when its
 * Discogs retry gives up. The first one is carried; the same id 404ing again
 * in a later run (`prior`) settles. An artist failure never costs the album
 * its six release columns.
 */

import type { FillCandidate } from './cohort.js';
import type { LmlFetcher } from './fetch.js';
import * as map from './map.js';
import type { ExtendedColumn, TooLongColumn } from './map.js';
import { checkPin, type PinLookup } from './pins.js';
import * as write from './write.js';

export type FillOutcome =
  | 'filled'
  | 'nothing_new'
  | 'release_changed'
  | 'write_failed'
  | 'release_not_found_suspected'
  | 'release_not_found'
  | 'release_unanswered'
  | 'pin_disagrees'
  | 'pin_unanswered'
  | 'no_release_id';

export type ArtistOutcome = 'answered' | 'not_asked' | 'unanswered' | 'not_found_suspected' | 'not_found';

export interface AlbumResult {
  outcome: FillOutcome;
  artist: ArtistOutcome;
  /** Listed again in `next_run`: an unanswered call, a first 404, or a failed write. */
  carried: boolean;
  releaseId?: number;
  artistId?: number;
  /** The missing columns the write gave a value. */
  filled: ExtendedColumn[];
  tooLong: TooLongColumn[];
  cached?: boolean;
}

/** Discogs ids that 404'd in an earlier run; a second 404 settles them. */
export interface PriorNotFound {
  releaseIds: ReadonlySet<number>;
  artistIds: ReadonlySet<number>;
}

export const NO_PRIOR_NOT_FOUND: PriorNotFound = { releaseIds: new Set(), artistIds: new Set() };

const CARRIED_OUTCOMES: ReadonlySet<FillOutcome> = new Set([
  'write_failed',
  'release_not_found_suspected',
  'release_unanswered',
  'pin_unanswered',
]);
const CARRIED_ARTIST: ReadonlySet<ArtistOutcome> = new Set(['unanswered', 'not_found_suspected']);

const notFound = (status: number, seenBefore: boolean) =>
  status !== 404 ? 'unanswered' : seenBefore ? 'not_found' : 'not_found_suspected';

const result = (outcome: FillOutcome, rest: Partial<AlbumResult> = {}): AlbumResult => {
  const artist = rest.artist ?? 'not_asked';
  const written = outcome === 'filled' || outcome === 'nothing_new';
  return {
    filled: [],
    tooLong: [],
    ...rest,
    outcome,
    artist,
    carried: CARRIED_OUTCOMES.has(outcome) || (written && CARRIED_ARTIST.has(artist)),
  };
};

/**
 * Fill one album. `pin` is its entry from `lookupBatchPins`. An `LmlAuthError`
 * is not caught: it is fatal to the run.
 */
export const fillAlbum = async (
  candidate: FillCandidate,
  lml: LmlFetcher,
  pin: PinLookup | undefined,
  prior: PriorNotFound
): Promise<AlbumResult> => {
  const releaseId = map.parseDiscogsReleaseId(candidate.discogs_url);
  if (releaseId === undefined) {
    return result('no_release_id');
  }
  const pinCheck = checkPin(releaseId, pin);
  if (pinCheck !== 'proceed') {
    return result(pinCheck, { releaseId });
  }
  const release = await lml.release(releaseId);
  if ('status' in release) {
    const status = notFound(release.status, prior.releaseIds.has(releaseId));
    return result(status === 'unanswered' ? 'release_unanswered' : `release_${status}`, { releaseId });
  }
  const { columns, tooLong } = map.mapRelease(release.value);
  const values: write.FillValues = { ...columns, artist_image_url: null, bio_tokens: null };
  const artistId = columns.discogs_artist_id ?? undefined;
  let artist: ArtistOutcome = 'not_asked';
  if (artistId !== undefined) {
    const fetched = await lml.artist(artistId);
    if ('status' in fetched) {
      artist = notFound(fetched.status, prior.artistIds.has(artistId));
    } else {
      const mapped = map.mapArtist(fetched.value);
      Object.assign(values, mapped.columns);
      tooLong.push(...mapped.tooLong);
      artist = 'answered';
    }
  }
  const base = { releaseId, artistId, artist, tooLong, cached: release.value.cached ?? false };
  const filled = candidate.missing.filter((c) => values[c] != null && (c !== 'bio_tokens' || candidate.has_bio));
  if (filled.length === 0) {
    return result('nothing_new', base);
  }
  try {
    return (await write.writeFill(candidate, values))
      ? result('filled', { ...base, filled })
      : result('release_changed', base);
  } catch {
    return result('write_failed', base);
  }
};
