/**
 * Unit tests for album-critic-reviews-etl's match.ts (BS#1830).
 *
 * `stripAlbumDecoration` ports the issue's literal regex verbatim — a
 * narrow trailing-parenthetical strip, deliberately NOT the broader
 * `normalizeAlbumTitle` free-text normalizer (that would loosen the
 * exact-match ceiling the issue calls a feature, not a gap).
 *
 * `matchItem` calls the real `resolveLinkedAlbumId` (mocked here via
 * `@wxyc/database`'s jest module mapper) and only retries with the
 * decoration-stripped title when stripping actually changed something —
 * pinned via call-count assertions so a regression that always double-calls
 * is caught.
 */
import { resolveLinkedAlbumId } from '@wxyc/database';
import { stripAlbumDecoration, matchItem } from '../../../../jobs/album-critic-reviews-etl/match';
import type { CorpusItem } from '../../../../jobs/album-critic-reviews-etl/manifest';

const mockResolve = resolveLinkedAlbumId as jest.MockedFunction<typeof resolveLinkedAlbumId>;

const item = (overrides: Partial<CorpusItem> = {}): CorpusItem => ({
  artist: 'Duke Ellington & John Coltrane',
  album: 'Duke Ellington & John Coltrane',
  source: 'The Quietus',
  sourceUrl: 'https://thequietus.com/reviews/duke-ellington-john-coltrane/',
  articleText: 'A landmark session.',
  ...overrides,
});

describe('stripAlbumDecoration', () => {
  it.each(['reissue', 'deluxe', 'remaster', 'remastered', 'expanded', 'ep', 'deluxe edition', 'Reissue', 'REMASTER'])(
    'strips a trailing "(%s ...)" clause',
    (keyword) => {
      expect(stripAlbumDecoration(`Pet Sounds (${keyword})`)).toBe('Pet Sounds');
      expect(stripAlbumDecoration(`Pet Sounds (${keyword} edition, 2011)`)).toBe('Pet Sounds');
    }
  );

  it('is a no-op when there is no trailing parenthetical', () => {
    expect(stripAlbumDecoration('Pet Sounds')).toBe('Pet Sounds');
  });

  it('preserves a non-edition trailing parenthetical (e.g. "(Live)")', () => {
    expect(stripAlbumDecoration('On Your Own Love Again (Live)')).toBe('On Your Own Love Again (Live)');
  });

  it('only strips a TRAILING clause, not one in the middle of the title', () => {
    expect(stripAlbumDecoration('DOGA (Deluxe) Sessions')).toBe('DOGA (Deluxe) Sessions');
  });
});

describe('matchItem', () => {
  beforeEach(() => {
    mockResolve.mockReset();
  });

  it('returns the album id on a direct exact-match hit without any fallback call', async () => {
    mockResolve.mockResolvedValueOnce(42);
    const albumId = await matchItem(item());
    expect(albumId).toBe(42);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith(item().artist, item().album);
  });

  it('retries once with the decoration-stripped title on a miss, and returns the fallback hit', async () => {
    mockResolve.mockResolvedValueOnce(null).mockResolvedValueOnce(7);
    const albumId = await matchItem(item({ album: 'Pet Sounds (Remastered)' }));
    expect(albumId).toBe(7);
    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockResolve).toHaveBeenNthCalledWith(2, item().artist, 'Pet Sounds');
  });

  it('returns null when both the exact match and the fallback miss', async () => {
    mockResolve.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const albumId = await matchItem(item({ album: 'Pet Sounds (Deluxe)' }));
    expect(albumId).toBeNull();
    expect(mockResolve).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry when the title has no decoration to strip (stripped === original)', async () => {
    mockResolve.mockResolvedValueOnce(null);
    const albumId = await matchItem(item({ album: 'Pet Sounds' }));
    expect(albumId).toBeNull();
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });
});
