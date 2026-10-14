/**
 * What one LML bulk result is allowed to write (BS#3137, "Verdicts"). Pure —
 * no I/O. Mirrors `jobs/album-metadata-bio-fill/decide.ts` (copied, not
 * extracted: decision 6).
 *
 * Exactly three verdicts write: `rebind`, `rebind_unpinned` and `clear`. The
 * others name each way of not getting an answer the job may trust, so the run
 * summary counts them by name and none of them can fall through into a write.
 */

import { isTrustedLmlAlbumMatch, type BulkLookupResultItem } from '@wxyc/lml-client';
import { CLEAR_RELEASE_GROUP, buildPayload, type ReleaseGroup, type RebindPayload } from './payload.js';

/**
 * One cohort row, with its manifest grade. `pin_mismatch`: the card has a pin
 * (`pin_release_id`) and the row stores another release. `pin_removed`: step 2
 * removed the card's pin, and the row still stores that removed release
 * (`stored_release_id`); `expected_release_id` is step 2's play-corroborated
 * no-pin release for a tier-1 card, and null for a tier-2a card.
 */
export type ReaskCandidate = {
  legacy_release_id: number;
  artist_name: string;
  album_title: string | null;
  reason: 'pin_mismatch' | 'pin_removed';
  stored_release_id: number | null;
  pin_release_id: number | null;
  expected_release_id: number | null;
};

export type Verdict =
  /** LML did not answer for this album: the call threw, a shed, an error, a
   * result out of input order, a `match` with nothing in it, or any degraded
   * answer. Not evidence of anything — asked again next run. `unexpectedIndex`
   * separates the one case that points at an LML contract break. */
  | { kind: 'indeterminate'; unexpectedIndex: boolean }
  /** A pinned card that LML could not find at all, so the pin did not bind. */
  | { kind: 'no_match' }
  /** LML found something by a fallback search, not the literal artist and album. */
  | { kind: 'untrusted' }
  /** LML resolved a different catalog card than the one this row belongs to. */
  | { kind: 'card_mismatch' }
  /** A pinned card answered with a release other than the pin: LML did not
   * apply it (an edited pin, the floor flag, or a failed prefetch). */
  | { kind: 'pin_not_bound' }
  /** A removed pin's card answered with the removed release: for the step 2 owner. */
  | { kind: 'matcher_agrees_with_removed' }
  /** A removed pin's card answered against the manifest: a release other than
   * the expected one (any release, for tier 2a), or no release for tier 1. */
  | { kind: 'unpinned_drifted' }
  /** The right release with no `release_url`, the `release_id: 0` shape on a
   * pinned card, or no artwork at all. */
  | { kind: 'incomplete' }
  | { kind: 'rebind' | 'rebind_unpinned'; release_id: number; payload: RebindPayload }
  /** A tier-2a removed card that LML now finds no release for (decision 3). */
  | { kind: 'clear'; payload: { release: Readonly<ReleaseGroup>; artist: null } };

const INDETERMINATE: Verdict = { kind: 'indeterminate', unexpectedIndex: false };

/** A trusted, healthy answer that names no release for this card. */
const noRelease = (candidate: ReaskCandidate): Verdict => {
  if (candidate.reason === 'pin_mismatch') return { kind: 'no_match' };
  if (candidate.expected_release_id !== null) return { kind: 'unpinned_drifted' };
  return { kind: 'clear', payload: { release: CLEAR_RELEASE_GROUP, artist: null } };
};

export const decideReask = (
  candidate: ReaskCandidate,
  item: BulkLookupResultItem | undefined,
  position: number
): Verdict => {
  // A thrown bulk call reaches here as a missing item.
  if (!item) return INDETERMINATE;
  // BS#1088: LML's bulk handler honours input order today. If that ever broke
  // silently, this is what stops one album's release landing on another.
  if (item.index !== position) return { kind: 'indeterminate', unexpectedIndex: true };
  // Decision 8: a degraded answer (`cache_only`, `deadline_exceeded`,
  // `upstream_unavailable`) never writes and never settles, however complete
  // it looks. It can lack the release details or the artist tail, and a
  // degraded `no_match` is a shed, not proof the release is gone.
  if (item.lookup?.degraded === true) return INDETERMINATE;
  if (item.status === 'no_match') return noRelease(candidate);

  // Branch on `status`, never on `lookup` nullity: a shed carries a non-null
  // placeholder `lookup`, so reading nullity would treat it as a match.
  const lookup = item.status === 'match' ? item.lookup : null;
  const top = lookup?.results?.[0];
  if (!lookup || !top) return INDETERMINATE;

  if (!isTrustedLmlAlbumMatch(lookup)) return { kind: 'untrusted' };

  // LML's `library_item.id` is the legacy card id (the pin's `library_id`),
  // which is why the candidate carries `legacy_release_id`.
  if (top.library_item?.id !== candidate.legacy_release_id) return { kind: 'card_mismatch' };

  const artwork = top.artwork;
  if (!artwork) return { kind: 'incomplete' };
  // LML's synthetic streaming-only shape (LML#401) names no release.
  if (!(artwork.release_id > 0)) {
    return candidate.reason === 'pin_mismatch' ? { kind: 'incomplete' } : noRelease(candidate);
  }

  const releaseId = artwork.release_id;
  let kind: 'rebind' | 'rebind_unpinned';
  if (candidate.reason === 'pin_mismatch') {
    if (releaseId !== candidate.pin_release_id) return { kind: 'pin_not_bound' };
    kind = 'rebind';
  } else {
    if (releaseId === candidate.stored_release_id) return { kind: 'matcher_agrees_with_removed' };
    // Only step 2's play-corroborated release is written; an ungraded matcher
    // pick is what this remediation exists to undo.
    if (releaseId !== candidate.expected_release_id) return { kind: 'unpinned_drifted' };
    kind = 'rebind_unpinned';
  }

  if (!artwork.release_url) return { kind: 'incomplete' };
  const payload = buildPayload(lookup, { artist: candidate.artist_name, album: candidate.album_title });
  return { kind, release_id: releaseId, payload };
};
