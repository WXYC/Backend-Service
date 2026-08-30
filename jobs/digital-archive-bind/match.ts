/**
 * Matcher (BS#2319 step 4): resolve a `CandidateAlbum` to exactly one
 * `library.id`, against `rotation` for rotation-derived content and against
 * `library` for `freeform/` content (`classify.isRotationDerived` decides
 * which caller uses which).
 *
 * Two tiers, EXACT then FUZZY, exact-first is load-bearing (the
 * `jobs/album-reviews-etl/link.ts` precedent this mirrors): the fuzzy tier
 * is strictly a coarsening of the exact one, so an ambiguity the exact tier
 * already sees can only stay ambiguous or resolve wrongly if fuzzy-matched
 * anyway -- it must never be given the chance. An exact-tier ambiguity is
 * therefore returned immediately, without trying fuzzy at all.
 *
 * "Fuzzy" here is deterministic punctuation/diacritic folding
 * (`relaxedAlbumKey`), never a similarity score -- see `normalize.ts`'s
 * header for why a scored matcher was deliberately not built.
 */

import { normalizeAlbumTitle } from '@wxyc/database';
import { artistFoldKey, relaxedAlbumKey } from './normalize.js';
import type { CandidateAlbum, MatchResult } from './types.js';

export interface RotationCandidateRow {
  libraryId: number;
  artistName: string | null;
  albumTitle: string | null;
}

export interface LibraryCandidateRow {
  libraryId: number;
  artistName: string | null;
  albumArtist: string | null;
  alternateArtistName: string | null;
  albumTitle: string | null;
}

const distinctLibraryIds = (ids: readonly number[]): number[] => [...new Set(ids)];

const resolveFromIds = (ids: readonly number[], tier: 'exact' | 'fuzzy'): MatchResult | null => {
  const distinct = distinctLibraryIds(ids);
  if (distinct.length === 0) return null;
  if (distinct.length > 1) return { kind: 'ambiguous', libraryIds: distinct };
  return { kind: 'matched', libraryId: distinct[0], tier, note: tier === 'exact' ? 'exact' : 'fuzzy:relaxed-key' };
};

export const matchRotation = (candidate: CandidateAlbum, rows: readonly RotationCandidateRow[]): MatchResult => {
  const exactIds = rows
    .filter(
      (r) =>
        foldEq(r.artistName, candidate.artistFoldKey) && r.albumTitle && normEq(r.albumTitle, candidate.albumNormKey)
    )
    .map((r) => r.libraryId);
  const exact = resolveFromIds(exactIds, 'exact');
  if (exact) return exact;

  const fuzzyIds = rows
    .filter(
      (r) =>
        foldEq(r.artistName, candidate.artistFoldKey) &&
        r.albumTitle &&
        relaxedAlbumKey(r.albumTitle) === relaxedAlbumKeyForCandidate(candidate)
    )
    .map((r) => r.libraryId);
  const fuzzy = resolveFromIds(fuzzyIds, 'fuzzy');
  if (fuzzy) return fuzzy;

  return { kind: 'unmatched' };
};

export const matchLibrary = (candidate: CandidateAlbum, rows: readonly LibraryCandidateRow[]): MatchResult => {
  const exactIds = rows
    .filter(
      (r) =>
        (foldEq(r.artistName, candidate.artistFoldKey) || foldEq(r.albumArtist, candidate.artistFoldKey)) &&
        r.albumTitle &&
        normEq(r.albumTitle, candidate.albumNormKey)
    )
    .map((r) => r.libraryId);
  const exact = resolveFromIds(exactIds, 'exact');
  if (exact) return exact;

  const candidateRelaxed = relaxedAlbumKeyForCandidate(candidate);
  const fuzzyIds = rows
    .filter(
      (r) =>
        (foldEq(r.artistName, candidate.artistFoldKey) ||
          foldEq(r.albumArtist, candidate.artistFoldKey) ||
          foldEq(r.alternateArtistName, candidate.artistFoldKey)) &&
        r.albumTitle &&
        relaxedAlbumKey(r.albumTitle) === candidateRelaxed
    )
    .map((r) => r.libraryId);
  const fuzzy = resolveFromIds(fuzzyIds, 'fuzzy');
  if (fuzzy) return fuzzy;

  return { kind: 'unmatched' };
};

// `candidate.artistFoldKey` is already a fold key; `row.artistName` is raw
// text straight from the DB, so it needs folding at compare time.
const foldEq = (raw: string | null, candidateFoldKey: string): boolean => artistFoldKey(raw) === candidateFoldKey;

const normEq = (raw: string, candidateNormKey: string): boolean => normalizeAlbumTitle(raw) === candidateNormKey;

// `candidate.albumNormKey` is already `normalizeAlbumTitle` output;
// `relaxedAlbumKey` further folds it -- computed once per candidate call
// rather than once per row, matching `link.ts`'s "once per candidate" note.
const relaxedAlbumKeyForCandidate = (candidate: CandidateAlbum): string => relaxedAlbumKey(candidate.albumNormKey);
