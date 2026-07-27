/**
 * Unit tests for album-critic-reviews-etl's dedup.ts (BS#1830).
 *
 * `compareSourcePreference` must be a TOTAL ORDER over every source the
 * manifest can contain, including one never explicitly ranked (a future
 * upstream research-data addition). The unranked-source-still-wins case is
 * the acceptance criterion's explicit recall-bug guard: an album whose only
 * review is from an unranked source must still get a card, never be
 * silently dropped for lacking a rank.
 */
import {
  RANKED_SOURCES,
  compareSourcePreference,
  dedupeByAlbum,
} from '../../../../jobs/album-critic-reviews-etl/dedup';
import type { CorpusItem } from '../../../../jobs/album-critic-reviews-etl/manifest';

const item = (source: string, sourceUrl = `https://example.com/${source}`): CorpusItem => ({
  artist: 'Jessica Pratt',
  album: 'On Your Own Love Again',
  source,
  sourceUrl,
  articleText: 'text',
});

describe('RANKED_SOURCES', () => {
  it('is the editorial head followed by the proposed expansion order', () => {
    expect(RANKED_SOURCES).toEqual([
      'The Quietus',
      'Tiny Mix Tapes',
      'Bandcamp Daily',
      'The Line of Best Fit',
      'Drowned in Sound',
      'Paste',
      'Beats Per Minute',
      'A Closer Listen',
      'HHV Mag',
    ]);
  });
});

describe('compareSourcePreference', () => {
  it('orders ranked sources by their position in RANKED_SOURCES', () => {
    expect(compareSourcePreference('The Quietus', 'Tiny Mix Tapes')).toBeLessThan(0);
    expect(compareSourcePreference('Tiny Mix Tapes', 'The Quietus')).toBeGreaterThan(0);
    expect(compareSourcePreference('Bandcamp Daily', 'The Line of Best Fit')).toBeLessThan(0);
  });

  it('matches ranked sources case-insensitively', () => {
    expect(compareSourcePreference('the quietus', 'TINY MIX TAPES')).toBeLessThan(0);
  });

  it('always ranks a ranked source ahead of an unranked one, regardless of alphabetical order', () => {
    // "Z Magazine" would sort after "HHV Mag" alphabetically, but HHV Mag is
    // ranked and Z Magazine is not — ranked always wins.
    expect(compareSourcePreference('HHV Mag', 'Z Magazine')).toBeLessThan(0);
    expect(compareSourcePreference('A Magazine', 'The Quietus')).toBeGreaterThan(0);
  });

  it('orders two unranked sources alphabetically, case-insensitively (deterministic fallback tail)', () => {
    expect(compareSourcePreference('Zephyr Zine', 'Aardvark Weekly')).toBeGreaterThan(0);
    expect(compareSourcePreference('aardvark weekly', 'ZEPHYR ZINE')).toBeLessThan(0);
  });

  it('is reflexively zero for identical sources', () => {
    expect(compareSourcePreference('Paste', 'Paste')).toBe(0);
    expect(compareSourcePreference('Some New Zine', 'Some New Zine')).toBe(0);
  });
});

describe('dedupeByAlbum', () => {
  it('picks the single item when only one review matched an album', () => {
    const matched = [{ item: item('Some New Zine'), albumId: 1 }];
    const deduped = dedupeByAlbum(matched);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].item.source).toBe('Some New Zine');
  });

  it('picks the highest-ranked source among competing reviews for the same album', () => {
    const matched = [
      { item: item('Paste'), albumId: 1 },
      { item: item('The Quietus'), albumId: 1 },
      { item: item('HHV Mag'), albumId: 1 },
    ];
    const deduped = dedupeByAlbum(matched);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].item.source).toBe('The Quietus');
  });

  it('THE RECALL-BUG GUARD: an album whose sole matched review is from an unranked source still gets a card', () => {
    const matched = [{ item: item('Some New Zine Nobody Ranked'), albumId: 1 }];
    const deduped = dedupeByAlbum(matched);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].item.source).toBe('Some New Zine Nobody Ranked');
  });

  it('when only unranked sources compete for an album, the alphabetically-first one wins deterministically', () => {
    const matched = [
      { item: item('Zephyr Zine'), albumId: 1 },
      { item: item('Aardvark Weekly'), albumId: 1 },
    ];
    const deduped = dedupeByAlbum(matched);
    expect(deduped[0].item.source).toBe('Aardvark Weekly');
  });

  it('keeps one representative per distinct album_id, independent of the others', () => {
    const matched = [
      { item: item('Paste'), albumId: 1 },
      { item: item('The Quietus'), albumId: 2 },
      { item: item('HHV Mag'), albumId: 2 },
    ];
    const deduped = dedupeByAlbum(matched);
    expect(deduped).toHaveLength(2);
    const bySource = new Map(deduped.map((d) => [d.albumId, d.item.source]));
    expect(bySource.get(1)).toBe('Paste');
    expect(bySource.get(2)).toBe('The Quietus');
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeByAlbum([])).toEqual([]);
  });
});
