/**
 * Unit tests for album-critic-reviews-etl's extract.ts (BS#1830).
 *
 * `buildRow`'s cap/boundary-trim logic is lifted from
 * `scripts/seed-critic-reviews.ts`'s `toRow` — see that file's docstring for
 * the sentence/word-boundary-past-60%-or-reject rationale. `llmExtract` is
 * exercised against a fake Anthropic client (no real SDK call).
 *
 * DELIBERATE DEVIATION FROM THE SEED SCRIPT, pinned here: author precedence
 * is REVERSED. The issue: "Manifest `author` wins over the LLM-guessed
 * author when present." The seed script had `extraction.author ?? item.author`
 * (LLM wins); this job does `item.author ?? extraction.author` (manifest wins).
 */
import {
  buildRow,
  MAX_SNIPPET,
  MAX_AUTHOR,
  MAX_RATING,
  MAX_SOURCE_URL,
  llmExtract,
  type Extraction,
} from '../../../../jobs/album-critic-reviews-etl/extract';
import type { CorpusItem } from '../../../../jobs/album-critic-reviews-etl/manifest';

const item = (overrides: Partial<CorpusItem> = {}): CorpusItem => ({
  artist: 'Jessica Pratt',
  album: 'On Your Own Love Again',
  source: 'The Quietus',
  sourceUrl: 'https://thequietus.com/reviews/jessica-pratt/',
  articleText: 'A hazy, intimate record.',
  ...overrides,
});

const extraction = (overrides: Partial<Extraction> = {}): Extraction => ({
  isReview: true,
  snippet: 'A remarkable, hazy record that rewards close listening.',
  author: null,
  rating: null,
  ...overrides,
});

describe('buildRow', () => {
  it('builds a row when the snippet fits within MAX_SNIPPET as-is', () => {
    const row = buildRow(item(), 1, extraction());
    expect(row).not.toBeNull();
    expect(row?.snippet).toBe('A remarkable, hazy record that rewards close listening.');
    expect(row?.album_id).toBe(1);
    expect(row?.source).toBe('The Quietus');
    expect(row?.source_url).toBe(item().sourceUrl);
    expect(row?.source_key).toBe('manifest:The Quietus');
  });

  it('returns null when isReview is false', () => {
    expect(buildRow(item(), 1, extraction({ isReview: false }))).toBeNull();
  });

  it('returns null when the snippet is empty after whitespace collapse', () => {
    expect(buildRow(item(), 1, extraction({ snippet: '   ' }))).toBeNull();
  });

  it('trims an over-length snippet at the last sentence boundary past 60% of the cap', () => {
    // The period lands at index 205 (> MAX_SNIPPET * 0.6 = 180) and the
    // total length exceeds MAX_SNIPPET, so the sentence-boundary arm fires.
    const lead =
      'This record is a genuinely excellent and richly detailed collection of songs that rewards patience ' +
      'and close, careful listening from start to finish, unfolding new textures on every subsequent play through';
    const goodClause = `${lead}. `;
    const filler = 'x'.repeat(150);
    const snippet = goodClause + filler;
    expect(snippet.length).toBeGreaterThan(MAX_SNIPPET);
    const row = buildRow(item(), 1, extraction({ snippet }));
    expect(row).not.toBeNull();
    expect(row.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET);
    expect(row.snippet.endsWith('.')).toBe(true);
    expect(row.snippet).toBe(goodClause.trim());
  });

  it('falls back to a word boundary when no sentence boundary clears 60% of the cap', () => {
    // No '.', '!', or '?' anywhere before the cut, so only the word-boundary
    // arm is available.
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const row = buildRow(item(), 1, extraction({ snippet: words }));
    expect(row).not.toBeNull();
    expect(row.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET);
    expect(row.snippet.endsWith(' ')).toBe(false);
    expect(words.startsWith(row.snippet)).toBe(true);
  });

  it('rejects (returns null) when neither boundary clears 60% of the cap', () => {
    // One giant unbroken "word" past the cap with no space/sentence-ending
    // punctuation anywhere before 60% of MAX_SNIPPET.
    const snippet = 'x'.repeat(MAX_SNIPPET * 2);
    expect(buildRow(item(), 1, extraction({ snippet }))).toBeNull();
  });

  describe('author precedence (REVERSED from the seed script)', () => {
    it('manifest author wins when both are present', () => {
      const row = buildRow(item({ author: 'Manifest Author' }), 1, extraction({ author: 'LLM Author' }));
      expect(row?.author).toBe('Manifest Author');
    });

    it('falls back to the LLM-guessed author when the manifest has none', () => {
      const row = buildRow(item({ author: undefined }), 1, extraction({ author: 'LLM Author' }));
      expect(row?.author).toBe('LLM Author');
    });

    it('is null when neither has an author', () => {
      const row = buildRow(item({ author: undefined }), 1, extraction({ author: null }));
      expect(row?.author).toBeNull();
    });
  });

  it('rating falls through extraction then manifest then null (unchanged from the seed script)', () => {
    expect(buildRow(item({ rating: '7.8' }), 1, extraction({ rating: '9.0' }))?.rating).toBe('9.0');
    expect(buildRow(item({ rating: '7.8' }), 1, extraction({ rating: null }))?.rating).toBe('7.8');
    expect(buildRow(item({ rating: undefined }), 1, extraction({ rating: null }))?.rating).toBeNull();
  });

  it('carries discogsReleaseId through when the manifest has one, else null', () => {
    expect(buildRow(item({ discogsReleaseId: 12345 }), 1, extraction())?.discogs_release_id).toBe(12345);
    expect(buildRow(item(), 1, extraction())?.discogs_release_id).toBeNull();
  });

  it('carries publishedAt through as published_at, else null', () => {
    expect(buildRow(item({ publishedAt: '2024-09-30' }), 1, extraction())?.published_at).toBe('2024-09-30');
    expect(buildRow(item(), 1, extraction())?.published_at).toBeNull();
  });

  describe('column-ceiling enforcement (varchar limits from migration 0125)', () => {
    it('nulls an over-length author rather than overflowing varchar(128); the review still builds', () => {
      const longAuthor = 'A'.repeat(MAX_AUTHOR + 1);
      const row = buildRow(item({ author: longAuthor }), 1, extraction({ author: null }));
      expect(row).not.toBeNull();
      expect(row?.author).toBeNull();
      expect(row?.snippet).toBe(extraction().snippet);
    });

    it('keeps an author exactly at the ceiling', () => {
      const author = 'A'.repeat(MAX_AUTHOR);
      expect(buildRow(item({ author }), 1, extraction())?.author).toBe(author);
    });

    it('nulls an over-length rating rather than overflowing varchar(32); the review still builds', () => {
      const longRating = '8/10 — one of the very best of the whole year';
      expect(longRating.length).toBeGreaterThan(MAX_RATING);
      const row = buildRow(item(), 1, extraction({ rating: longRating }));
      expect(row).not.toBeNull();
      expect(row?.rating).toBeNull();
    });

    it('keeps a rating exactly at the ceiling', () => {
      const rating = '8'.repeat(MAX_RATING);
      expect(buildRow(item(), 1, extraction({ rating }))?.rating).toBe(rating);
    });

    it('rejects the whole row when source_url exceeds varchar(1024) (link-out target cannot be truncated)', () => {
      const longUrl = `https://example.com/${'x'.repeat(MAX_SOURCE_URL)}`;
      expect(buildRow(item({ sourceUrl: longUrl }), 1, extraction())).toBeNull();
    });

    it('keeps a source_url exactly at the ceiling', () => {
      const url = `https://e/${'x'.repeat(MAX_SOURCE_URL - 10)}`;
      expect(url.length).toBe(MAX_SOURCE_URL);
      expect(buildRow(item({ sourceUrl: url }), 1, extraction())?.source_url).toBe(url);
    });
  });
});

describe('llmExtract', () => {
  const fakeClient = (toolInput: Partial<Extraction> | null) => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: toolInput === null ? [] : [{ type: 'tool_use', name: 'record_snippet', input: toolInput }],
      }),
    },
  });

  it('parses a well-formed tool_use response', async () => {
    const client = fakeClient({ isReview: true, snippet: 'Great record.', author: 'A. Reviewer', rating: '8/10' });
    const result = await llmExtract(item(), client);
    expect(result).toEqual({ isReview: true, snippet: 'Great record.', author: 'A. Reviewer', rating: '8/10' });
  });

  it('coerces a blank author/rating string to null', async () => {
    const client = fakeClient({ isReview: true, snippet: 'Great record.', author: '  ', rating: '' });
    const result = await llmExtract(item(), client);
    expect(result.author).toBeNull();
    expect(result.rating).toBeNull();
  });

  it('throws when the model does not return a tool_use block', async () => {
    const client = fakeClient(null);
    await expect(llmExtract(item(), client)).rejects.toThrow(/tool_use/);
  });
});
