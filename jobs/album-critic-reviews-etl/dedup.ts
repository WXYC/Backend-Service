/**
 * Source-preference dedup for album-critic-reviews-etl (BS#1830): pick one
 * review per matched album, by an explicit total order over sources.
 *
 * `RANKED_SOURCES` is DATA, not a switch — the editorial head (The Quietus
 * -> Tiny Mix Tapes -> Bandcamp Daily, carried over from the seed era) plus
 * the "Proposed" expansion order from the issue (The Line of Best Fit ->
 * Drowned in Sound -> Paste -> Beats Per Minute -> A Closer Listen -> HHV
 * Mag). The expansion order is an UNCONFIRMED editorial judgment call per
 * the issue ("confirm with the music director / editorial before merge") —
 * this PR ships it as the working default; re-ranking later is a one-line
 * edit to this array, not a code change.
 *
 * `compareSourcePreference` is a TOTAL order over every source the manifest
 * can contain, including one never explicitly ranked here: an unranked
 * source falls back to a deterministic name-sorted tail rather than being
 * excluded. That's the acceptance criterion's recall-bug guard — an album
 * whose only review comes from an unranked (e.g. a future upstream
 * addition) source must still get a card. The upstream `SOURCES` list in
 * research-data's `build_manifest.py` can grow with zero code change here:
 * a new source just lands in the fallback tail until someone explicitly
 * ranks it.
 */
import type { CorpusItem } from './manifest.js';

export const RANKED_SOURCES = [
  'The Quietus',
  'Tiny Mix Tapes',
  'Bandcamp Daily',
  'The Line of Best Fit',
  'Drowned in Sound',
  'Paste',
  'Beats Per Minute',
  'A Closer Listen',
  'HHV Mag',
] as const;

const rankIndex = new Map(RANKED_SOURCES.map((source, index) => [source.toLowerCase(), index]));

/** Total order: ranked sources by their position in RANKED_SOURCES first;
 *  anything unranked sorts after every ranked source, tie-broken
 *  alphabetically (case-insensitive) so the fallback tail is deterministic. */
export const compareSourcePreference = (a: string, b: string): number => {
  const aRank = rankIndex.get(a.toLowerCase());
  const bRank = rankIndex.get(b.toLowerCase());
  if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
  if (aRank !== undefined) return -1;
  if (bRank !== undefined) return 1;
  return a.toLowerCase().localeCompare(b.toLowerCase());
};

export interface MatchedItem {
  item: CorpusItem;
  albumId: number;
}

/** Group matched items by albumId, keep exactly one per group — the item
 *  whose source sorts first under compareSourcePreference. Never drops an
 *  album for lacking a ranked source (see module docstring). */
export const dedupeByAlbum = (matched: MatchedItem[]): MatchedItem[] => {
  const byAlbum = new Map<number, MatchedItem>();
  for (const candidate of matched) {
    const current = byAlbum.get(candidate.albumId);
    if (!current || compareSourcePreference(candidate.item.source, current.item.source) < 0) {
      byAlbum.set(candidate.albumId, candidate);
    }
  }
  return [...byAlbum.values()];
};
