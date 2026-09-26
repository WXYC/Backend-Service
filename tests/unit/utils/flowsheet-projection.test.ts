import {
  projectFlowsheetEntry,
  pickClientFacingColumns,
  toDiscogsUnavailableWireFields,
  CLIENT_FACING_FLOWSHEET_COLUMNS,
} from '../../../apps/backend/utils/flowsheet-projection';
import { INTERNAL_FLOWSHEET_COLUMNS, makeFullFlowsheetRow } from '../../fixtures/flowsheet-row.fixture';
import type { DiscogsUnavailableFlags } from '../../../apps/backend/services/library.service';

/**
 * BS#1513. The mutation (`addEntry`/`deleteEntry`/`updateEntry`/`changeOrder`)
 * and DJ peek paths used to serialize the raw `flowsheet` row from Drizzle
 * `.returning()` / `db.select().from(flowsheet)` — every column, including
 * internal ones. `projectFlowsheetEntry` is the explicit client-facing
 * allow-list those paths now run their rows through. The internal-column
 * deny-list and the fully-populated row live in the shared fixture
 * (tests/fixtures/flowsheet-row.fixture.ts) so all three leak suites cover a
 * new internal column from one update site.
 */

describe('projectFlowsheetEntry (BS#1513)', () => {
  it('drops every internal column from the projected payload', () => {
    const projected = projectFlowsheetEntry(makeFullFlowsheetRow());
    for (const internalKey of INTERNAL_FLOWSHEET_COLUMNS) {
      expect(projected).not.toHaveProperty(internalKey);
    }
  });

  it('preserves every client-facing column with its original value', () => {
    const row = makeFullFlowsheetRow();
    const projected = projectFlowsheetEntry(row);
    for (const key of CLIENT_FACING_FLOWSHEET_COLUMNS) {
      expect(projected[key]).toEqual(row[key]);
    }
  });

  it('exposes exactly the allow-listed keys — no more, no less', () => {
    const projected = projectFlowsheetEntry(makeFullFlowsheetRow());
    expect(new Set(Object.keys(projected))).toEqual(new Set(CLIENT_FACING_FLOWSHEET_COLUMNS));
  });

  it('keeps the discriminator (entry_type) and description fields convertV2Entry reads', () => {
    // dj-site's POST /flowsheet consumer (convertV2Entry) branches on
    // entry_type and reads these flat fields; dropping any would break the
    // optimistic-insert reconciliation. Pins that contract.
    const projected = projectFlowsheetEntry(makeFullFlowsheetRow());
    for (const key of [
      'id',
      'show_id',
      'play_order',
      'entry_type',
      'artist_name',
      'album_title',
      'track_title',
      'record_label',
      'request_flag',
      'segue',
      'album_id',
      'rotation_id',
      'artwork_url',
      'add_time',
    ] as const) {
      expect(projected).toHaveProperty(key);
    }
  });

  it('keeps metadata_status — client-facing per the SSOT, not internal', () => {
    // Deliberate deviation from #1513's AC wording (PR #1532 review); the
    // canonical rationale lives in the CLIENT_FACING_FLOWSHEET_COLUMNS module
    // docstring (flowsheet-projection.ts), one edit site for the SSOT story.
    const projected = projectFlowsheetEntry(makeFullFlowsheetRow());
    expect(projected.metadata_status).toBe('enriched_match');
  });

  it('does not mutate the input row', () => {
    const row = makeFullFlowsheetRow();
    const before = { ...row };
    projectFlowsheetEntry(row);
    expect(row).toEqual(before);
  });

  it('projects a message/marker row without inventing track fields', () => {
    const row = makeFullFlowsheetRow({ entry_type: 'talkset', message: 'Talkset', track_title: null });
    const projected = projectFlowsheetEntry(row);
    expect(projected.message).toBe('Talkset');
    expect(projected.entry_type).toBe('talkset');
    expect(projected).not.toHaveProperty('search_doc');
  });

  // BS#1714: fill-only persistence left non-Spotify/non-Apple URLs under the
  // spotify_url/apple_music_url columns before #1712's ingestion guard shipped.
  // The projector host-guards them so iOS never binds a Deezer URL to the
  // hardwired green "Spotify" button.
  describe('BS#1714 streaming-URL host guard', () => {
    it('drops a non-Spotify spotify_url to null (Deezer under the Spotify field)', () => {
      const projected = projectFlowsheetEntry(
        makeFullFlowsheetRow({ spotify_url: 'https://www.deezer.com/album/254381182' })
      );
      expect(projected.spotify_url).toBeNull();
    });

    it('drops a non-Apple apple_music_url to null', () => {
      const projected = projectFlowsheetEntry(
        makeFullFlowsheetRow({ apple_music_url: 'https://tidal.com/browse/album/254381182' })
      );
      expect(projected.apple_music_url).toBeNull();
    });

    it('drops a suffix-spoof host to null (spotify.com.evil.example)', () => {
      const projected = projectFlowsheetEntry(
        makeFullFlowsheetRow({ spotify_url: 'https://open.spotify.com.evil.example/album/1' })
      );
      expect(projected.spotify_url).toBeNull();
    });

    it('passes a genuine Spotify/Apple URL through unchanged', () => {
      const projected = projectFlowsheetEntry(
        makeFullFlowsheetRow({
          spotify_url: 'https://open.spotify.com/album/genuine',
          apple_music_url: 'https://music.apple.com/us/album/genuine',
        })
      );
      expect(projected.spotify_url).toBe('https://open.spotify.com/album/genuine');
      expect(projected.apple_music_url).toBe('https://music.apple.com/us/album/genuine');
    });

    it('leaves the other three streaming fields untouched when spotify_url is mislabeled', () => {
      const row = makeFullFlowsheetRow({ spotify_url: 'https://www.deezer.com/album/1' });
      const projected = projectFlowsheetEntry(row);
      expect(projected.youtube_music_url).toBe(row.youtube_music_url);
      expect(projected.bandcamp_url).toBe(row.bandcamp_url);
      expect(projected.soundcloud_url).toBe(row.soundcloud_url);
    });

    // BS#2697 narrows this leg from "on a Spotify host" to "names a release or
    // a search". The inline flowsheet copy needs it as much as the
    // album_metadata one: the projection emits these columns verbatim, so a
    // persisted artist page reaches the hardwired iOS "Spotify" button directly.
    describe('BS#2697 album-slot narrowing', () => {
      it.each([
        ['artist page', 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7'],
        ['track page', 'https://open.spotify.com/track/1A2GTWGtFfWp7KSQTwWOyo'],
        ['id-less /album', 'https://open.spotify.com/album'],
      ])('drops an on-host non-release spotify_url to null (%s)', (_label, url) => {
        expect(projectFlowsheetEntry(makeFullFlowsheetRow({ spotify_url: url })).spotify_url).toBeNull();
      });

      it('keeps a synthesized search URL — the premise that foreclosed this option', () => {
        // 3,787 persisted rows carry one. `isSpotifyUrl` accepts them and so
        // does `isSpotifyAlbumSlotUrl`; if this goes red the narrowing has
        // started eating working links.
        const url = 'https://open.spotify.com/search/Cat%20Power%20Moon%20Pix';
        expect(projectFlowsheetEntry(makeFullFlowsheetRow({ spotify_url: url })).spotify_url).toBe(url);
      });

      it('keeps a locale-prefixed album page', () => {
        const url = 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo';
        expect(projectFlowsheetEntry(makeFullFlowsheetRow({ spotify_url: url })).spotify_url).toBe(url);
      });

      it('does not narrow apple_music_url alongside it (BS#2691 is separate)', () => {
        // A null apple_music_url has no search fallback (BS#1192), so the same
        // narrowing there blanks the button instead of degrading it.
        const apple = 'https://music.apple.com/us/artist/cat-power/12345';
        expect(projectFlowsheetEntry(makeFullFlowsheetRow({ apple_music_url: apple })).apple_music_url).toBe(apple);
      });
    });
  });
});

describe('pickClientFacingColumns (BS#1534)', () => {
  // JSON-tolerant sibling for parsed-JSON rows (the CDC `to_jsonb(NEW)` payload
  // on the anonymous SSE stream). Loops the same allow-list, so the leak-defense
  // coverage carries over; these tests pin the JSON-specific behaviors.

  it('drops every internal column and keeps the client columns from a full parsed row', () => {
    // Emulate the parsed-JSON shape: dates arrive as ISO strings, not Dates.
    const raw = JSON.parse(JSON.stringify(makeFullFlowsheetRow())) as Record<string, unknown>;
    const picked = pickClientFacingColumns(raw);
    for (const internalKey of INTERNAL_FLOWSHEET_COLUMNS) {
      expect(picked).not.toHaveProperty(internalKey);
    }
    expect(new Set(Object.keys(picked))).toEqual(new Set(CLIENT_FACING_FLOWSHEET_COLUMNS));
  });

  it('copies only the columns actually present — a partial row is not padded with invented keys', () => {
    const picked = pickClientFacingColumns({ id: 7, artist_name: 'Jessica Pratt', legacy_entry_id: 9999 });
    expect(picked).toEqual({ id: 7, artist_name: 'Jessica Pratt' });
    expect(picked).not.toHaveProperty('album_title');
    expect(picked).not.toHaveProperty('legacy_entry_id');
  });

  it('passes values through untouched (ISO-string date stays a string)', () => {
    const picked = pickClientFacingColumns({ id: 7, add_time: '2024-02-01T12:00:00.000Z' });
    expect(picked.add_time).toBe('2024-02-01T12:00:00.000Z');
  });

  it('ignores a prototype-polluting key that collides with nothing in the allow-list', () => {
    const picked = pickClientFacingColumns(JSON.parse('{"id":7,"__proto__":{"polluted":true}}'));
    expect(picked).toEqual({ id: 7 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // BS#1714: the same host guard on the parsed-JSON CDC `liveFs:update` payload.
  describe('BS#1714 streaming-URL host guard', () => {
    it('nulls a present-but-mislabeled spotify_url (Deezer) while keeping the key', () => {
      const picked = pickClientFacingColumns({ id: 7, spotify_url: 'https://www.deezer.com/album/1' });
      expect(picked.spotify_url).toBeNull();
      expect('spotify_url' in picked).toBe(true);
    });

    it('nulls a present-but-mislabeled apple_music_url', () => {
      const picked = pickClientFacingColumns({ id: 7, apple_music_url: 'https://tidal.com/browse/album/1' });
      expect(picked.apple_music_url).toBeNull();
    });

    // BS#2697: this is the fourth changed call site and the only one on the CDC
    // push path. The cases above cannot detect a revert to `isSpotifyUrl` —
    // a Deezer URL and a genuine album page are classified identically by both
    // predicates — so without these the whole suite stays green if this seam
    // alone loses the narrowing.
    it.each([
      ['artist page', 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7'],
      ['track page', 'https://open.spotify.com/track/1A2GTWGtFfWp7KSQTwWOyo'],
      ['id-less /album', 'https://open.spotify.com/album'],
    ])('nulls an ON-HOST non-release spotify_url on the CDC payload (%s)', (_label, url) => {
      const picked = pickClientFacingColumns({ id: 7, spotify_url: url });
      expect(picked.spotify_url).toBeNull();
      expect('spotify_url' in picked).toBe(true);
    });

    it.each([
      ['album page', 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo'],
      ['locale-prefixed album', 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo'],
      ['synthesized search URL', 'https://open.spotify.com/search/Cat%20Power%20Moon%20Pix'],
    ])('keeps a legitimate album-slot value on the CDC payload (%s)', (_label, url) => {
      expect(pickClientFacingColumns({ id: 7, spotify_url: url }).spotify_url).toBe(url);
    });

    it('passes a genuine Spotify/Apple URL through unchanged', () => {
      const picked = pickClientFacingColumns({
        id: 7,
        spotify_url: 'https://open.spotify.com/album/genuine',
        apple_music_url: 'https://music.apple.com/us/album/genuine',
      });
      expect(picked.spotify_url).toBe('https://open.spotify.com/album/genuine');
      expect(picked.apple_music_url).toBe('https://music.apple.com/us/album/genuine');
    });

    it('does not invent a streaming key that was absent from the partial row', () => {
      const picked = pickClientFacingColumns({ id: 7, artist_name: 'Jessica Pratt' });
      expect(picked).not.toHaveProperty('spotify_url');
      expect(picked).not.toHaveProperty('apple_music_url');
    });
  });
});

describe('toDiscogsUnavailableWireFields (BS#1962)', () => {
  // Mirrors #1908's flowsheet.discogsUnavailable.test.ts wire-shape cases —
  // this is the single point where the SSE feeder and the mutation-echo
  // feeder share the present-or-absent camelCase semantics with the V2 read
  // path's transformToV2.

  it('undefined (no album_id, or album_id misses in library) -> {} (both absent)', () => {
    const result = toDiscogsUnavailableWireFields(undefined);
    expect(result).toEqual({});
    expect(result).not.toHaveProperty('discogsUnavailable');
    expect(result).not.toHaveProperty('discogsUnavailableNote');
  });

  it('resolved row with the flag UNSET -> discogsUnavailable: false present, note absent', () => {
    const flags: DiscogsUnavailableFlags = {
      discogsUnavailable: false,
      discogsUnavailableNote: null,
      lastDiscogsRecheckAt: null,
    };
    const result = toDiscogsUnavailableWireFields(flags);
    expect(result).toEqual({ discogsUnavailable: false });
    expect(result).not.toHaveProperty('discogsUnavailableNote');
  });

  it('resolved row with the flag SET + a note -> both fields present', () => {
    const flags: DiscogsUnavailableFlags = {
      discogsUnavailable: true,
      discogsUnavailableNote: 'Embargoed promo pressing',
      lastDiscogsRecheckAt: null,
    };
    const result = toDiscogsUnavailableWireFields(flags);
    expect(result).toEqual({
      discogsUnavailable: true,
      discogsUnavailableNote: 'Embargoed promo pressing',
    });
  });

  it('resolved row with the flag SET but no note -> only discogsUnavailable present', () => {
    const flags: DiscogsUnavailableFlags = {
      discogsUnavailable: true,
      discogsUnavailableNote: null,
      lastDiscogsRecheckAt: null,
    };
    const result = toDiscogsUnavailableWireFields(flags);
    expect(result).toEqual({ discogsUnavailable: true });
    expect(result).not.toHaveProperty('discogsUnavailableNote');
  });

  it('never emits lastDiscogsRecheckAt — that rides the proxy album-detail surface only', () => {
    const flags: DiscogsUnavailableFlags = {
      discogsUnavailable: true,
      discogsUnavailableNote: 'note',
      lastDiscogsRecheckAt: new Date('2026-07-01T00:00:00Z'),
    };
    const result = toDiscogsUnavailableWireFields(flags);
    expect(result).not.toHaveProperty('lastDiscogsRecheckAt');
  });
});
