/**
 * `buildArtistKeepSet` — decision 8 on BS#3137, the BS#3128 artist rule with "same release" false (BS#3145).
 *
 * The unit tier mocks `drizzle-orm`, so these pin the rendered text and which values travel bound. The stored
 * `discogs_artist_id` is only known to the database (the write reads it under `FOR UPDATE`), so the "both ids set"
 * arm is a `CASE` in SQL; the "answer id null" arm is decided here, so SQL never compares a bound NULL. The same
 * table runs against real rows in `tests/integration/album-metadata-reask.spec.js`.
 *
 * @see WXYC/Backend-Service#3145
 */

import { describe, it, expect } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { renderSql } from '../../../utils/render-sql';
import { buildArtistKeepSet } from '../../../../jobs/album-metadata-reask/artist-keep-sql';
import type { ArtistGroup } from '../../../../jobs/album-metadata-reask/payload';

const stored = (key: string) => sql`p.${sql.identifier(key)}`;
const flat = (chunk: unknown): string => renderSql(chunk).replace(/\s+/g, ' ');

const ANSWER: ArtistGroup = {
  discogs_artist_id: 61002,
  artist_bio: null,
  artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
  artist_image_url: null,
  bio_tokens: null,
};

const KEPT = ['artist_bio', 'artist_wikipedia_url', 'artist_image_url', 'bio_tokens'] as const;

describe('buildArtistKeepSet', () => {
  it('always writes discogs_artist_id as answered, cast to int', () => {
    for (const answer of [ANSWER, { ...ANSWER, discogs_artist_id: null }]) {
      expect(flat(buildArtistKeepSet(answer, stored).discogs_artist_id)).toBe(`${answer.discogs_artist_id ?? ''}::int`);
    }
  });

  it.each([
    // "Either id null", answer side: decided in JS. A rebind changes the release, so the answer is written as-is.
    ['the answer has no artist id', null, (col: string, cast: string) => `::${cast}`],
    // "Both ids set": kept only when the stored id is equal; a NULL stored id makes the test NULL, so "either id null"
    // on the stored side also writes as answered. Each answered value is bound once.
    [
      'the answer has an artist id',
      61002,
      (col: string, cast: string) =>
        `COALESCE(::${cast}, CASE WHEN p."discogs_artist_id" = 61002::int THEN p."${col}" END)`,
    ],
  ])('when %s, each artist-scoped column follows the rule', (_label, id, expected) => {
    const set = buildArtistKeepSet({ ...ANSWER, discogs_artist_id: id, artist_wikipedia_url: null }, stored);
    const casts = { artist_bio: 'text', artist_wikipedia_url: 'text', artist_image_url: 'text', bio_tokens: 'jsonb' };

    for (const col of KEPT) expect(flat(set[col])).toBe(expected(col, casts[col]));
  });

  it('binds a non-null answer value, which wins over the stored one through COALESCE', () => {
    const set = buildArtistKeepSet(ANSWER, stored);

    expect(flat(set.artist_wikipedia_url)).toMatch(/^COALESCE\(https:\/\/en.wikipedia.org\/wiki\/Juana_Molina::text, /);
  });

  it('binds bio_tokens as JSON text, and a null as SQL NULL rather than the JSON null', () => {
    const tokens = [{ type: 'text', text: 'Argentine singer' }] as unknown as ArtistGroup['bio_tokens'];
    const set = buildArtistKeepSet({ ...ANSWER, discogs_artist_id: null, bio_tokens: tokens }, stored);
    const none = buildArtistKeepSet({ ...ANSWER, discogs_artist_id: null }, stored);

    expect((set.bio_tokens as unknown as { values: unknown[] }).values).toEqual([JSON.stringify(tokens)]);
    expect((none.bio_tokens as unknown as { values: unknown[] }).values).toEqual([null]);
  });
});
