/**
 * The listen-first link lookup (BS#3391): after an item is added, or renamed by an edit, LML's streaming-check is asked for the
 * record's Spotify, Apple Music and Bandcamp links, and one UPDATE fills the empty ones. A music director's Bandcamp link is never
 * replaced; every LML URL is screened before it is stored; an answer for names the record no longer has is dropped; an LML error
 * writes nothing. The rename's clearing is the PATCH's own (`intake.service.sql.test.ts`). The LML client is mocked; the UPDATE runs
 * against a stand-in builder with the real schema, and its `SET` and `WHERE` are rendered.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

const mockCheck = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let lmlConfigured = true;
jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('../../../shared/lml-client/src/streaming-url-guard'),
  checkStreamingAvailability: mockCheck,
  isLmlConfigured: () => lmlConfigured,
}));

const mockCapture = jest.fn();
jest.mock('../../../apps/backend/utils/posthog', () => ({ getPostHogClient: () => ({ capture: mockCapture }) }));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@wxyc/database';
import { isAppleMusicUrl, isBandcampUrl, isSpotifyAlbumSlotUrl } from '@wxyc/lml-client';
import { lookUpIntakeLinks, screenLinkUrl } from '../../../apps/backend/services/intake-links.service';
import { createLockLog } from '../../utils/lock-log-builder';

const ITEM = { id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' };
const SPOTIFY = 'https://open.spotify.com/album/a';
const APPLE = 'https://music.apple.com/us/album/a/1';
const BANDCAMP = 'https://juanamolina.bandcamp.com/album/doga';
const match = (url: string) => ({ url, confidence: 95 });
const answer = (sources: Record<string, string | null>, errored_sources?: string[]) => ({
  on_streaming: Object.values(sources).some(Boolean),
  sources: Object.fromEntries(Object.entries(sources).map(([key, url]) => [key, url === null ? null : match(url)])),
  ...(errored_sources && { errored_sources }),
});
const ALL = answer({
  spotify: SPOTIFY,
  deezer: 'https://www.deezer.com/album/1',
  apple_music: APPLE,
  bandcamp: BANDCAMP,
});

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

describe('lookUpIntakeLinks (BS#3391)', () => {
  const { builder, sets, wheres } = createLockLog();

  const run = async (result: unknown) => {
    sets.length = 0;
    wheres.length = 0;
    if (result instanceof Error) {
      mockCheck.mockRejectedValue(result);
    } else {
      mockCheck.mockResolvedValue(result);
    }
    const update = jest.spyOn(db, 'update').mockReturnValue(builder([{ id: 7 }]) as never);
    await lookUpIntakeLinks(ITEM);
    return { update, set: sets[0] };
  };

  beforeEach(() => {
    lmlConfigured = true;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks LML for the record by its names, under the intake label', async () => {
    await run(ALL);
    expect(mockCheck).toHaveBeenCalledWith('Juana Molina', 'DOGA', { caller: 'intake-streaming-links' });
  });

  /** [case, LML's answer, the Spotify, Apple Music and Bandcamp URLs the UPDATE offers to fill]. */
  it.each([
    ['matches on all three fill all three, Deezer ignored', ALL, [SPOTIFY, APPLE, BANDCAMP]],
    [
      'no matches offer nulls',
      answer({ spotify: null, deezer: null, apple_music: null, bandcamp: null }),
      [null, null, null],
    ],
    [
      'a URL that fails its screen is offered as null',
      answer({
        spotify: 'https://open.spotify.com/artist/a',
        apple_music: 'javascript://music.apple.com/a',
        bandcamp: null,
      }),
      [null, null, null],
    ],
  ])(
    '%s, only where the column is null, and stamps the check time',
    async (_name, result, [spotify, apple, bandcamp]) => {
      const { update, set } = await run(result);
      expect(update).toHaveBeenCalledTimes(1);
      expect(Object.keys(set).sort()).toEqual(['apple_music_url', 'bandcamp_url', 'links_checked_at', 'spotify_url']);
      expect(render(set.spotify_url)).toMatchObject({
        sql: 'coalesce("wxyc_schema"."intake_items"."spotify_url", $1)',
        params: [spotify],
      });
      expect(render(set.apple_music_url)).toMatchObject({
        sql: 'coalesce("wxyc_schema"."intake_items"."apple_music_url", $1)',
        params: [apple],
      });
      // An entered link is kept outright; otherwise the column is filled only when it is null.
      expect(render(set.bandcamp_url)).toMatchObject({
        sql: 'CASE WHEN "wxyc_schema"."intake_items"."bandcamp_url_entered" THEN "wxyc_schema"."intake_items"."bandcamp_url" ELSE coalesce("wxyc_schema"."intake_items"."bandcamp_url", $1) END',
        params: [bandcamp],
      });
      expect(render(set.links_checked_at)).toMatchObject({ sql: 'now()' });
    }
  );

  it('leaves the item unchanged and does not throw when LML errors', async () => {
    const { update } = await run(new Error('LML down'));
    expect(update).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('Intake link lookup failed:', 'LML down');
  });

  it('calls nothing when LML is not configured', async () => {
    lmlConfigured = false;
    const { update } = await run(ALL);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  describe('an answer for names the record no longer has', () => {
    /** A stand-in UPDATE that touches the one row only when its `WHERE` (id, artist, album) still matches it, as Postgres would. */
    const row = { ...ITEM };
    let written: boolean;
    const guardedUpdate = () => {
      let where: SQL | undefined;
      const chain = {
        set: () => chain,
        where: (predicate: SQL) => {
          where = predicate;
          return chain;
        },
        then: (resolve: (rows: unknown[]) => void) => {
          const [id, artist, album] = render(where).params;
          written = id === row.id && artist === row.artist_name && album === row.album_title;
          resolve([]);
        },
      };
      return chain;
    };

    beforeEach(() => {
      Object.assign(row, ITEM);
      written = false;
      jest.spyOn(db, 'update').mockImplementation(guardedUpdate as never);
    });

    it.each([
      ['is dropped when a rename lands while the lookup is in flight', true, false],
      ['is written when the names are unchanged', false, true],
    ])('%s', async (_name, renamedMeanwhile, expected) => {
      let answerLml!: (value: unknown) => void;
      mockCheck.mockReturnValue(new Promise((resolve) => (answerLml = resolve)));
      const lookup = lookUpIntakeLinks(ITEM);
      if (renamedMeanwhile) {
        row.album_title = 'Moon Pix';
      }
      answerLml(ALL);
      await lookup;
      expect(written).toBe(expected);
    });
  });

  describe('partial-error telemetry, as the library filing service sends it', () => {
    it('sends one streaming_check_partial_error event when some services errored', async () => {
      await run(answer({ spotify: SPOTIFY, apple_music: null, bandcamp: null }, ['apple_music', 'bandcamp']));
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: 'intake_item:7',
        event: 'streaming_check_partial_error',
        properties: {
          caller: 'intake-streaming-links',
          intake_item_id: 7,
          artist: 'Juana Molina',
          title: 'DOGA',
          on_streaming_verdict: true,
          errored_sources: ['apple_music', 'bandcamp'],
        },
      });
    });

    it.each([
      ['no errored_sources', ALL],
      ['an empty errored_sources', answer({ spotify: SPOTIFY }, [])],
    ])('sends nothing for %s', async (_name, result) => {
      await run(result);
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it('warns and still stores the links when PostHog fails', async () => {
      mockCapture.mockImplementationOnce(() => {
        throw new Error('posthog unreachable');
      });
      const { update } = await run(answer({ spotify: SPOTIFY }, ['bandcamp']));
      expect(console.warn).toHaveBeenCalledWith('Failed to emit streaming-check telemetry:', 'posthog unreachable');
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});

describe('screenLinkUrl: every LML URL meets the stored-link bar before it is stored (BS#3391)', () => {
  const LONG = `https://open.spotify.com/album/${'a'.repeat(512 - 'https://open.spotify.com/album/'.length + 1)}`;
  const BANDCAMP_DOGA = 'https://sonamos.bandcamp.com/album/doga';
  it.each([
    ['a Spotify album', SPOTIFY, isSpotifyAlbumSlotUrl, SPOTIFY],
    [
      'a localized Spotify album',
      'https://open.spotify.com/intl-de/album/a',
      isSpotifyAlbumSlotUrl,
      'https://open.spotify.com/intl-de/album/a',
    ],
    ['an Apple Music album', APPLE, isAppleMusicUrl, APPLE],
    ['a Bandcamp album', BANDCAMP, isBandcampUrl, BANDCAMP],
    [
      'a Bandcamp custom-domain storefront',
      'https://records.example.com/album/x',
      isBandcampUrl,
      'https://records.example.com/album/x',
    ],
    ['exactly 512 characters', LONG.slice(0, 512), isSpotifyAlbumSlotUrl, LONG.slice(0, 512)],
    ['a Spotify artist page', 'https://open.spotify.com/artist/a', isSpotifyAlbumSlotUrl, null],
    ['a Spotify track', 'https://open.spotify.com/track/a', isSpotifyAlbumSlotUrl, null],
    ['another host under spotify_url', 'https://www.deezer.com/album/1', isSpotifyAlbumSlotUrl, null],
    ['another host under apple_music_url', 'https://music.apple.com.evil.example/album/a', isAppleMusicUrl, null],
    ['a non-http scheme with an Apple authority', 'javascript://music.apple.com/%0aalert(1)', isAppleMusicUrl, null],
    ['plain http', 'http://music.apple.com/us/album/a/1', isAppleMusicUrl, null],
    ['credentials', 'https://user@open.spotify.com/album/a', isSpotifyAlbumSlotUrl, null],
    ['a backslash before userinfo', 'https://x.bandcamp.com\\@evil.example/a', isBandcampUrl, null],
    ['a backslash as the authority slashes', 'https:\\\\x.bandcamp.com/a', isBandcampUrl, null],
    ['an inner space', 'https://x.bandcamp.com/a b', isBandcampUrl, null],
    ['a tab', 'https://open.spotify.com/album/\ta', isSpotifyAlbumSlotUrl, null],
    ['a newline', 'https://music.apple.com/us/album/a/1\n', isAppleMusicUrl, null],
    ['a NUL character', 'https://x.bandcamp.com/\u0000a', isBandcampUrl, null],
    ['a DEL character', 'https://x.bandcamp.com/\u007fa', isBandcampUrl, null],
    ['over 512 characters', LONG, isSpotifyAlbumSlotUrl, null],
    // The stored form is the URL's `href`, the form the PATCH controller makes of a sent link, so an echoed found link equals the stored one.
    [
      'a bare Bandcamp host gains its trailing slash',
      'https://sonamos.bandcamp.com',
      isBandcampUrl,
      'https://sonamos.bandcamp.com/',
    ],
    ['an uppercase host is lowercased', 'https://Sonamos.Bandcamp.com/album/doga', isBandcampUrl, BANDCAMP_DOGA],
    ['the default port is dropped', 'https://sonamos.bandcamp.com:443/album/doga', isBandcampUrl, BANDCAMP_DOGA],
    [
      'a non-ASCII path is percent-encoded',
      'https://sonamos.bandcamp.com/album/dóga',
      isBandcampUrl,
      'https://sonamos.bandcamp.com/album/d%C3%B3ga',
    ],
    ['an href over 512 characters', `https://sonamos.bandcamp.com/album/${'ó'.repeat(100)}`, isBandcampUrl, null],
    ['a non-URL', 'not a link', isBandcampUrl, null],
    ['null', null, isBandcampUrl, null],
    ['undefined', undefined, isBandcampUrl, null],
  ])('%s', (_name, url, isServiceUrl, expected) => {
    expect(screenLinkUrl(url, isServiceUrl)).toBe(expected);
  });
});
