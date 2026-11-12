/**
 * The release-pin gate (BS#1442). A row whose stored release disagrees with
 * LML's hand-verified pin (`lml_cache.library_release_override`) names the
 * wrong record, so it is settled as `pin_disagrees` and never filled; picking
 * the right release is BS#3137's. Pins are keyed by `library.legacy_release_id`.
 */

import type { PinnedTracklist, PinnedTracklistsResult } from '@wxyc/lml-client';
import type { FillCandidate } from './cohort.js';
import type { Fetched } from './fetch.js';

/** One album's pin: the answer (null is "no pin"), or the failed call's status. */
export type PinLookup = { ok: true; pin: PinnedTracklist | null } | { ok: false; status: number };

export type PinCheck = 'proceed' | 'pin_disagrees' | 'pin_unanswered';

/** `proceed` with no legacy id (`undefined`), no pin, or a pin naming the stored release. */
export const checkPin = (storedReleaseId: number, lookup: PinLookup | undefined): PinCheck => {
  if (lookup === undefined) {
    return 'proceed';
  }
  if ('status' in lookup) {
    return 'pin_unanswered';
  }
  return lookup.pin === null || lookup.pin.discogs_release_id === storedReleaseId ? 'proceed' : 'pin_disagrees';
};

/**
 * One pins call for a batch, keyed by `album_id`. Albums with no legacy id get
 * no entry. A failed call marks every album that has one unanswered.
 */
export const lookupBatchPins = async (
  batch: readonly FillCandidate[],
  lml: { pins(ids: number[]): Promise<Fetched<PinnedTracklistsResult[]>> }
): Promise<Map<number, PinLookup>> => {
  const keyed = batch.filter((c): c is FillCandidate & { legacy_release_id: number } => c.legacy_release_id !== null);
  const lookups = new Map<number, PinLookup>();
  if (keyed.length === 0) {
    return lookups;
  }
  const answer = await lml.pins(keyed.map((c) => c.legacy_release_id));
  keyed.forEach((c, i) => {
    lookups.set(
      c.album_id,
      'status' in answer ? { ok: false, status: answer.status } : { ok: true, pin: answer.value[i].pin }
    );
  });
  return lookups;
};
