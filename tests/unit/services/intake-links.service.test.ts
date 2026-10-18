/**
 * The listen-first link lookup (BS#3391): after an item is added, or renamed by an edit, LML's streaming-check is asked for the
 * record's Spotify, Apple Music and Bandcamp links, and one UPDATE stores them. A music director's Bandcamp link is never replaced;
 * a rename clears the found links it can no longer vouch for; an LML error writes nothing. The LML client is mocked; the UPDATE runs
 * against a stand-in builder with the real schema, and its `SET` is rendered to pin the keep-or-replace rules.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

const mockCheck = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let lmlConfigured = true;
jest.mock('@wxyc/lml-client', () => ({
  checkStreamingAvailability: mockCheck,
  isLmlConfigured: () => lmlConfigured,
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@wxyc/database';
import { lookUpIntakeLinks } from '../../../apps/backend/services/intake-links.service';
import { createLockLog } from '../../utils/lock-log-builder';

const ITEM = { id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' };
const MATCH = (url: string) => ({ url, confidence: 95 });
const ALL = {
  on_streaming: true,
  sources: {
    spotify: MATCH('https://open.spotify.com/album/a'),
    deezer: MATCH('https://www.deezer.com/album/1'),
    apple_music: MATCH('https://music.apple.com/us/album/a/1'),
    bandcamp: MATCH('https://juanamolina.bandcamp.com/album/doga'),
  },
};
const NONE = { on_streaming: false, sources: { spotify: null, deezer: null, apple_music: null, bandcamp: null } };

const dialect = new PgDialect();
/** A `SET` value as the test reads it: a plain value as itself, an SQL expression as its rendered text and params. */
const read = (value: unknown) =>
  value !== null && typeof value === 'object' ? dialect.sqlToQuery(value as never) : value;

describe('lookUpIntakeLinks (BS#3391)', () => {
  const { builder, sets } = createLockLog();

  const run = async (namesChanged: boolean, result?: unknown) => {
    sets.length = 0;
    if (result instanceof Error) {
      mockCheck.mockRejectedValue(result);
    } else {
      mockCheck.mockResolvedValue(result);
    }
    const update = jest.spyOn(db, 'update').mockReturnValue(builder([{ id: 7 }]) as never);
    await lookUpIntakeLinks(ITEM, namesChanged);
    return { update, set: sets[0] };
  };

  beforeEach(() => {
    lmlConfigured = true;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks LML for the record by its names, under the intake label', async () => {
    await run(false, ALL);
    expect(mockCheck).toHaveBeenCalledWith('Juana Molina', 'DOGA', { caller: 'intake-streaming-links' });
  });

  it('stores all three links and the check time in one UPDATE, ignoring Deezer', async () => {
    const { update, set } = await run(false, ALL);
    expect(update).toHaveBeenCalledTimes(1);
    expect(Object.keys(set).sort()).toEqual(['apple_music_url', 'bandcamp_url', 'links_checked_at', 'spotify_url']);
    expect(read(set.spotify_url)).toMatchObject({ params: ['https://open.spotify.com/album/a'] });
    expect(read(set.apple_music_url)).toMatchObject({ params: ['https://music.apple.com/us/album/a/1'] });
    expect(read(set.links_checked_at)).toMatchObject({ sql: 'now()' });
  });

  it('writes a link only where the column is null when the names are unchanged, and never over an entered Bandcamp link', async () => {
    const { set } = await run(false, ALL);
    expect(read(set.spotify_url)).toMatchObject({ sql: expect.stringContaining('coalesce(') });
    expect(read(set.bandcamp_url)).toMatchObject({
      sql: expect.stringMatching(/case when .*bandcamp_url_entered.* then .*bandcamp_url.* else coalesce\(/i),
    });
  });

  it('on a rename replaces the found links outright, null where LML found none, but keeps an entered Bandcamp link', async () => {
    const { set } = await run(true, { ...ALL, sources: { ...ALL.sources, apple_music: null } });
    expect(set.spotify_url).toBe('https://open.spotify.com/album/a');
    expect(set.apple_music_url).toBeNull();
    expect(read(set.bandcamp_url)).toMatchObject({ sql: expect.stringContaining('bandcamp_url_entered') });
  });

  it('with no matches still stamps the check time, and a rename clears the old links', async () => {
    const unchanged = await run(false, NONE);
    expect(Object.keys(unchanged.set)).toContain('links_checked_at');
    const renamed = await run(true, NONE);
    expect(renamed.set.spotify_url).toBeNull();
    expect(renamed.set.apple_music_url).toBeNull();
  });

  it('leaves the item unchanged and does not throw when LML errors', async () => {
    const { update } = await run(true, new Error('LML down'));
    expect(update).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('calls nothing when LML is not configured', async () => {
    lmlConfigured = false;
    const { update } = await run(false, ALL);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
