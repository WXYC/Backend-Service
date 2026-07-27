/**
 * Unit tests for the album-critic-reviews-etl manifest parser (BS#1830).
 * Pure — no DB, no network. The CorpusItem shape is the cross-repo contract
 * published by WXYC/research-data's build_manifest.py: required
 * artist/album/source/sourceUrl/articleText, optional author/publishedAt
 * (never emitted today: rating/discogsReleaseId — kept on the type per the
 * issue so a future manifest revision needs no ETL-side type change).
 */
import { parseManifestLines } from '../../../../jobs/album-critic-reviews-etl/manifest';

const validLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    artist: 'Chuquimamani-Condori',
    album: 'Edits',
    source: 'The Quietus',
    sourceUrl: 'https://thequietus.com/reviews/chuquimamani-condori-edits/',
    articleText: 'A radiant, overloaded, devotional record.',
    ...overrides,
  });

describe('parseManifestLines', () => {
  it('parses a well-formed line into a CorpusItem', () => {
    const { items, invalid } = parseManifestLines(validLine());
    expect(invalid).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      artist: 'Chuquimamani-Condori',
      album: 'Edits',
      source: 'The Quietus',
      sourceUrl: 'https://thequietus.com/reviews/chuquimamani-condori-edits/',
      articleText: 'A radiant, overloaded, devotional record.',
    });
  });

  it('skips blank lines without counting them as invalid', () => {
    const { items, invalid } = parseManifestLines(['', validLine(), '   ', ''].join('\n'));
    expect(items).toHaveLength(1);
    expect(invalid).toBe(0);
  });

  it('carries optional author and publishedAt when present', () => {
    const { items } = parseManifestLines(validLine({ author: 'Philip Sherburne', publishedAt: '2024-09-30' }));
    expect(items[0].author).toBe('Philip Sherburne');
    expect(items[0].publishedAt).toBe('2024-09-30');
  });

  it('leaves optional fields undefined when absent from the line', () => {
    const { items } = parseManifestLines(validLine());
    expect(items[0].author).toBeUndefined();
    expect(items[0].publishedAt).toBeUndefined();
    expect(items[0].rating).toBeUndefined();
    expect(items[0].discogsReleaseId).toBeUndefined();
  });

  it('carries optional rating and discogsReleaseId when a future manifest revision emits them', () => {
    const { items } = parseManifestLines(validLine({ rating: '7.8', discogsReleaseId: 12345 }));
    expect(items[0].rating).toBe('7.8');
    expect(items[0].discogsReleaseId).toBe(12345);
  });

  it('counts malformed JSON as invalid, never throws', () => {
    const { items, invalid } = parseManifestLines([validLine(), 'not json{', validLine()].join('\n'));
    expect(items).toHaveLength(2);
    expect(invalid).toBe(1);
  });

  it.each(['artist', 'album', 'source', 'sourceUrl', 'articleText'])(
    'counts a line missing required field %s as invalid',
    (field) => {
      const line = JSON.parse(validLine());
      delete line[field];
      const { items, invalid } = parseManifestLines(JSON.stringify(line));
      expect(items).toHaveLength(0);
      expect(invalid).toBe(1);
    }
  );

  it.each(['artist', 'album', 'source', 'sourceUrl', 'articleText'])(
    'counts a line with an empty-string required field %s as invalid',
    (field) => {
      const { items, invalid } = parseManifestLines(validLine({ [field]: '   ' }));
      expect(items).toHaveLength(0);
      expect(invalid).toBe(1);
    }
  );

  it('counts a line that is valid JSON but not an object (e.g. a bare array) as invalid', () => {
    const { items, invalid } = parseManifestLines('[1,2,3]');
    expect(items).toHaveLength(0);
    expect(invalid).toBe(1);
  });

  it('returns zero items and zero invalid for an empty string', () => {
    const { items, invalid } = parseManifestLines('');
    expect(items).toHaveLength(0);
    expect(invalid).toBe(0);
  });
});
