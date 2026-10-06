/**
 * What one LML bulk result is allowed to write (BS#2775). Pure — no I/O.
 *
 * Exactly one verdict, `fill`, writes. The others name each way of not getting
 * a trustworthy bio, so the run summary can say which happened and so none of
 * them can fall through into a write.
 */

import { isTrustedLmlAlbumMatch, type BulkLookupResultItem } from '@wxyc/lml-client';
import { normalizeLookup } from '@wxyc/metadata';
import type { BioFill, FillCandidate } from './cohort.js';

export type Verdict =
  /** LML did not answer for this album: a shed, an error, a result out of
   * input order, a `match` with nothing in it, or a degraded lookup that fell
   * short of a fill. Not evidence of anything — the album must be asked
   * again. `unexpectedIndex` separates the one case that points at an LML
   * contract break rather than at load. */
  | { kind: 'indeterminate'; unexpectedIndex: boolean }
  /** LML searched and found nothing. */
  | { kind: 'no_match' }
  /** LML found something by a fallback search, not the literal artist and album. */
  | { kind: 'untrusted' }
  /** LML resolved a different catalog card than the one this row belongs to. */
  | { kind: 'card_mismatch' }
  /** A trusted match on the right card that carries no bio. Not stable: an
   * LML breaker shed on the artist-details step looks identical from here. */
  | { kind: 'no_bio' }
  | { kind: 'fill'; fill: BioFill };

const classify = (candidate: FillCandidate, item: BulkLookupResultItem | undefined, position: number): Verdict => {
  // BS#1088: LML's bulk handler honours input order today. If that ever broke
  // silently, this is what stops one album's bio landing on another.
  if (item && item.index !== position) return { kind: 'indeterminate', unexpectedIndex: true };
  if (item?.status === 'no_match') return { kind: 'no_match' };

  // Branch on `status`, never on `lookup` nullity: a shed carries a non-null
  // placeholder `lookup`, so reading nullity would treat it as a match.
  const lookup = item?.status === 'match' ? item.lookup : null;
  const top = lookup?.results?.[0];
  if (!lookup || !top) return { kind: 'indeterminate', unexpectedIndex: false };

  if (!isTrustedLmlAlbumMatch(lookup)) return { kind: 'untrusted' };

  // LML resolves by search, so it can land on another catalog row. Its
  // `library_item.id` is the legacy card id — the id space `library.db` is
  // built in — which is why the candidate carries `legacy_release_id`.
  if (top.library_item?.id !== candidate.legacy_release_id) return { kind: 'card_mismatch' };

  // `normalizeLookup` rather than `artwork.artist_bio`: it cleans Discogs
  // markup and nulls both fields on a synthetic artwork, exactly as the
  // enrichment worker's write arm does. LML gates the bio to the top result.
  const { artist_bio, artist_wikipedia_url } = normalizeLookup(lookup, {
    artist: candidate.artist_name,
    album: candidate.album_title,
  });
  // A Wikipedia URL with no bio is `no_bio`: the cohort is defined by the bio,
  // so writing only the URL would leave the row to be re-asked forever.
  if (!artist_bio?.trim()) return { kind: 'no_bio' };

  return { kind: 'fill', fill: { artist_bio, artist_wikipedia_url } };
};

export const decideBioFill = (
  candidate: FillCandidate,
  item: BulkLookupResultItem | undefined,
  position: number
): Verdict => {
  const verdict = classify(candidate, item, position);
  // A degraded lookup shed its Discogs work (LML#755 / LML#930: `cache_only`,
  // `deadline_exceeded`, `upstream_unavailable`) and returned the library rows
  // alone. Bulk still labels it `match`, or `no_match` when no row came back,
  // so without this it would settle as `no_bio` and the cursor would walk past
  // it. A bio it did carry is still real, so only a non-fill is overridden.
  // Deliberately wider than the flowsheet re-enrichment jobs, which retry only
  // `upstream_unavailable`: the bio comes from the enrichment tail, which every
  // degraded reason sheds, so `deadline_exceeded` and `cache_only` lose it too.
  if (verdict.kind !== 'fill' && verdict.kind !== 'indeterminate' && item?.lookup?.degraded === true) {
    return { kind: 'indeterminate', unexpectedIndex: false };
  }
  return verdict;
};
