/**
 * BS#2103 cross-repo wire golden.
 *
 * The v=2 grouped `recentEntries` payload is consumed by iOS binaries that are
 * already in the App Store and cannot be changed. Every other test in this repo
 * asserts key names in JavaScript; none of them can observe what Swift's
 * `JSONDecoder` does with the bytes. This one pins the bytes so the other side
 * of the contract has something stable to decode.
 *
 * The fixture below is checked into BOTH repos:
 *   Backend-Service  tests/fixtures/recent-entries-v2-wire-golden.json   (source of truth)
 *   wxyc-ios-64      Shared/Playlist/Tests/PlaylistTests/Fixtures/
 *                      bs2103-enriched-payload.json                     (copy)
 *
 * They are byte-identical, and both repos assert {@link GOLDEN_SHA256}. So a
 * serializer change fails HERE first; updating the golden then changes the hash,
 * which fails the iOS suite until the copy is refreshed and the decode tests are
 * re-run. That is a deliberate two-step — there is no shared package to hang the
 * contract on (the legacy tubafrenzy shape is intentionally absent from
 * wxyc-shared's api.yaml, which is being decommissioned), so the hash is what
 * makes drift loud instead of silent.
 *
 * To regenerate after an intended serializer change:
 *   UPDATE_GOLDEN=1 npx jest --config jest.unit.config.ts playlist-proxy-wire-golden
 * then copy the file to wxyc-ios-64 and update GOLDEN_SHA256 in both suites.
 *
 * Every hazard in the matrix is drawn from a 2026-08-11 audit of production
 * `GET /flowsheet` — 50,200 entries, 37,054 playcut rows, ~206k URL values.
 * Notably the label-prefixed `artist_wikipedia_url` values are real (12 rows,
 * most recently played 2026-08-11) and each one THROWS
 * `DecodingError.dataCorrupted` on the shipped 3.2 decoder, which fails the
 * whole `Playlist` decode because `playcuts` is a non-optional array. The guard
 * that drops them is the only thing preventing a blank playlist: the v2 path
 * converts the same field with a non-throwing `URL(string:)`, but v1 does not.
 */
/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path here is GOLDEN_PATH, a module constant built from __dirname. There
 * is no caller-supplied input in this file. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- db mock (same shape as playlist-proxy.service.test.ts) ---

const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockLeftJoin = jest.fn();
const mockInnerJoin = jest.fn();
const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
const mockExecute = jest.fn();

const mockDbChain = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
};
mockFrom.mockReturnValue(mockDbChain);
mockLeftJoin.mockReturnValue(mockDbChain);
mockInnerJoin.mockReturnValue(mockDbChain);
mockWhere.mockReturnValue(mockDbChain);
mockOrderBy.mockReturnValue(mockDbChain);
mockExecute.mockResolvedValue([]);

const mockSelectDistinctOn = jest.fn();
const mockArtworkFrom = jest.fn();
const mockArtworkInnerJoin = jest.fn();
const mockArtworkWhere = jest.fn();
const mockArtworkOrderBy = jest.fn();

const artworkChain = {
  from: mockArtworkFrom,
  innerJoin: mockArtworkInnerJoin,
  where: mockArtworkWhere,
  orderBy: mockArtworkOrderBy,
};
mockSelectDistinctOn.mockReturnValue(artworkChain);
mockArtworkFrom.mockReturnValue(artworkChain);
mockArtworkInnerJoin.mockReturnValue(artworkChain);
mockArtworkWhere.mockReturnValue(artworkChain);

const mockMetadataFrom = jest.fn();
const mockMetadataLeftJoin = jest.fn();
const mockMetadataWhere = jest.fn();

const metadataChain = {
  from: mockMetadataFrom,
  leftJoin: mockMetadataLeftJoin,
  where: mockMetadataWhere,
};
mockMetadataFrom.mockReturnValue(metadataChain);
mockMetadataLeftJoin.mockReturnValue(metadataChain);

mockSelect.mockImplementation((fields: unknown) =>
  fields && typeof fields === 'object' && 'entry_type' in fields ? mockDbChain : metadataChain
);

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    selectDistinctOn: (...args: unknown[]) => mockSelectDistinctOn(...args),
    execute: (...args: unknown[]) => mockExecute(...args),
  },
  flowsheet: { id: 'flowsheet.id', album_id: 'flowsheet.album_id', entry_type: 'flowsheet.entry_type' },
  album_metadata: { album_id: 'album_metadata.album_id' },
  rotation: { id: 'rotation.id' },
  library: { id: 'library.id', artist_id: 'library.artist_id' },
  artists: { id: 'artists.id' },
}));

jest.mock('drizzle-orm', () => ({
  sql: Object.assign(jest.fn(), { raw: jest.fn(), join: jest.fn() }),
  inArray: jest.fn(),
  isNotNull: jest.fn(),
  and: jest.fn(),
  eq: jest.fn(),
  desc: jest.fn(),
  asc: jest.fn(),
}));

type AttachTarget = { upcoming_show?: unknown; critic_reviews?: unknown };
const mockAttachUpcomingShows = jest.fn((entries: AttachTarget[]) => Promise.resolve(entries));
const mockAttachCriticReviews = jest.fn((entries: AttachTarget[]) => Promise.resolve(entries));

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  attachUpcomingShows: (entries: AttachTarget[]) => mockAttachUpcomingShows(entries),
  attachCriticReviews: (entries: AttachTarget[]) => mockAttachCriticReviews(entries),
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { getRecentEntries } from '../../../apps/backend/services/playlist-proxy.service';

// --- The hazard matrix ---

const GOLDEN_PATH = join(__dirname, '../../fixtures/recent-entries-v2-wire-golden.json');

/**
 * SHA-256 of the golden, pinned HERE and in wxyc-ios-64
 * `BS2103EnrichedDecodingTests.swift`. Same shape as the charset-corpus drift
 * guard (`tests/fixtures/charset-torture.json.sha256` +
 * `.github/workflows/charset-corpus-drift.yml`): the pin lives in a different
 * file from the fixture, so regenerating one without acknowledging the other is
 * a red test rather than a silent change.
 */
const GOLDEN_SHA256 = '27be66ec764d332b8b5cd82889e9e140b367124269dcfe5f0077a1ddcafc7f3f';

/** Fixed ids and add_times — the payload must be byte-reproducible. */
function row(id: number, albumId: number | null, artist: string, album: string, track: string, seconds: number) {
  return {
    id,
    entry_type: 'track',
    add_time: new Date(Date.UTC(2026, 7, 11, 18, 0, seconds)),
    radio_hour: null,
    track_title: track,
    artist_name: artist,
    album_title: album,
    record_label: 'BS2103 Probe Records',
    request_flag: false,
    segue: false,
    message: null,
    rotation_id: null,
    album_id: albumId,
    rotation_bin: null,
  };
}

/** Every metadata column, so each probe states its whole row explicitly. */
function meta(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    discogs_url: null,
    release_year: null,
    spotify_url: null,
    apple_music_url: null,
    youtube_music_url: null,
    bandcamp_url: null,
    soundcloud_url: null,
    artist_bio: null,
    artist_wikipedia_url: null,
    genres: null,
    styles: null,
    artist_id: 7000,
    discogs_unavailable: false,
    discogs_unavailable_note: null,
    metadata_status: 'enriched_match',
    ...overrides,
  };
}

const ROWS = [
  row(9001, 990001, 'Nilüfer Yanya', 'PAINLESS', 'stabilise', 1),
  row(9002, 990002, 'João Gilberto', 'Chega de Saudade', 'Bim Bom', 2),
  row(9003, 990003, 'İbrahim Tatlıses', 'Selam Olsun', 'Mavi Mavi', 3),
  row(9004, 990004, 'Konono Nº1', 'Congotronics', 'Lufuala Ndonga', 4),
  row(9005, 990005, "Eiko Ishibashi & Jim O'Rourke", 'Ei', 'Ei', 5),
  row(9006, 990006, 'Hole', 'Live Through This', 'Violet', 6),
  row(9007, 990007, 'Art Garfunkel', 'Angel Clare', 'All I Know', 7),
  row(9008, 990008, 'Jessica Pratt', 'On Your Own Love Again', 'Back, Baby', 8),
  row(9009, 990009, 'Chuquimamani-Condori', 'DJ E', 'Call Your Name', 9),
  row(9010, 990010, 'Juana Molina', 'DOGA', 'la paradoja', 10),
  row(9011, 990011, 'Stereolab', 'Dots and Loops', 'Brakhage', 11),
  row(9012, null, 'BS2103 Unenriched Artist', 'BS2103 Unenriched Album', 'Probe Track (no metadata)', 12),
];

const METADATA = [
  // Fully enriched. `artist_wikipedia_url` carries RAW un-percent-encoded UTF-8,
  // exactly as persisted — `wireUrl` returns the trimmed original, not
  // `new URL(...).href`, so this reaches Swift verbatim. 21 such values in prod.
  meta(9001, {
    discogs_url: 'https://www.discogs.com/release/22012345',
    release_year: 2022,
    spotify_url: 'https://open.spotify.com/album/1234567890abcdef',
    apple_music_url: 'https://music.apple.com/us/album/painless/1609094304',
    youtube_music_url: 'https://music.youtube.com/playlist?list=OLAK5uy_bs2103',
    bandcamp_url: 'https://niluferyanya.bandcamp.com/album/painless',
    soundcloud_url: 'https://soundcloud.com/niluferyanya/stabilise',
    artist_bio: 'Nilüfer Yanya is a London-born singer-songwriter.',
    artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Nilüfer_Yanya',
    genres: ['Rock'],
    styles: ['Indie Rock', 'Art Rock'],
  }),
  meta(9002, { artist_wikipedia_url: 'http://en.wikipedia.org/wiki/João_Gilberto', genres: ['Jazz'] }),
  meta(9003, { artist_wikipedia_url: 'https://en.wikipedia.org/wiki/İbrahim_Tatlıses' }),
  meta(9004, { artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Konono_Nº1' }),
  // Raw apostrophes, parens and `!` in %-encoded search URLs — 1,300 in prod.
  meta(9005, {
    spotify_url: "https://open.spotify.com/search/Eiko%20Ishibashi%20%26%20Jim%20O'Rourke%20Ei",
    youtube_music_url: "https://music.youtube.com/search?q=Agriculture%20Dan's%20Love%20Song",
    soundcloud_url: "https://soundcloud.com/search?q=Agriculture%20Dan's%20Love%20Song",
    bandcamp_url:
      "https://bandcamp.com/search?q=Ash%20Wednesday%20Can't%20Stop%20It!%20Australian%20Post-Punk%201978-82%20(2025%20Deluxe%20Edition)",
  }),
  // Human-typed label prefix. Real, and fatal to the 3.2 decoder if emitted.
  meta(9006, { artist_wikipedia_url: 'Wiki - http://en.wikipedia.org/wiki/Hole_(band)' }),
  meta(9007, { artist_wikipedia_url: 'wikipedia : https://en.wikipedia.org/wiki/Art_Garfunkel' }),
  // The '' synthetic-match sentinel (LML#401/#487), NULLIF'd by BS#1628.
  meta(9008, { discogs_url: '' }),
  // Bandcamp URL filed under spotify_url — suppressed by the BS#1714 host guard.
  meta(9009, {
    spotify_url: 'https://chuquimamanicondori.bandcamp.com/album/dj-e',
    bandcamp_url: 'https://chuquimamanicondori.bandcamp.com/album/dj-e',
  }),
  meta(9010, { artist_wikipedia_url: '   ', discogs_url: '  https://www.discogs.com/release/999  ' }),
  meta(9011, {
    discogs_url: 'javascript:alert(1)',
    spotify_url: '//open.spotify.com/album/xyz',
    bandcamp_url: 'stereolab.bandcamp.com/album/dots-and-loops',
  }),
  // No library row at all, so the left joins yield NULL for both library-sourced
  // fields. `discogs_unavailable: null` is NOT the same claim as `false` — the
  // serializer omits the key entirely rather than asserting "is on Discogs"
  // (BS#1908), which is what the golden pins.
  meta(9012, { artist_id: null, discogs_unavailable: null, metadata_status: 'pending' }),
];

describe('BS#2103 v=2 wire golden (cross-repo contract with iOS 3.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockReturnValue(mockDbChain);
    mockLeftJoin.mockReturnValue(mockDbChain);
    mockInnerJoin.mockReturnValue(mockDbChain);
    mockWhere.mockReturnValue(mockDbChain);
    mockOrderBy.mockReturnValue(mockDbChain);
    mockSelect.mockImplementation((fields: unknown) =>
      fields && typeof fields === 'object' && 'entry_type' in fields ? mockDbChain : metadataChain
    );
    mockSelectDistinctOn.mockReturnValue(artworkChain);
    mockArtworkFrom.mockReturnValue(artworkChain);
    mockArtworkInnerJoin.mockReturnValue(artworkChain);
    mockArtworkWhere.mockReturnValue(artworkChain);
    mockExecute.mockResolvedValue([]);

    mockLimit.mockResolvedValue(ROWS);
    mockMetadataWhere.mockResolvedValue(METADATA);
    mockArtworkOrderBy.mockResolvedValue([
      { key: 'nilüfer yanya-painless', artwork_url: 'https://i.discogs.com/bs2103-painless.jpg' },
      { key: 'jessica pratt-on your own love again', artwork_url: 'https://i.discogs.com/bs2103-pratt.jpg' },
    ]);
    mockAttachUpcomingShows.mockImplementation((entries) => {
      // Only the first probe carries the snake_case embeds, so the golden pins
      // both the present and the absent case. The shape is the real `Concert`
      // contract (wxyc-ios-64 `Shared/Concerts/Sources/Concerts/Concert.swift`),
      // not a stub — iOS decodes this embed through `Concert`'s own Codable, so
      // a partial object would pin the degrade-to-nil path and quietly stop
      // proving the ticket CTA works.
      const first = entries[0];
      if (first) {
        first.upcoming_show = {
          id: 991,
          venue: {
            id: 12,
            slug: 'cats-cradle',
            name: 'Cat’s Cradle',
            city: 'Carrboro',
            state: 'NC',
            address: '300 E Main St',
          },
          starts_on: '2026-09-14',
          starts_at: '2026-09-15T00:00:00.000Z',
          doors_at: null,
          headlining_artist_raw: 'Nilüfer Yanya',
          headlining_artist_id: 7000,
          title: null,
          supporting_artists_raw: [],
          ticket_url: 'https://catscradle.example/tickets/991',
          image_url: null,
          event_url: null,
          price_min: 25,
          price_max: 30,
          age_restriction: 'all ages',
          status: 'on_sale',
          genres: ['Rock'],
          similar_artists: null,
          station_plays: 14,
          station_recommended: true,
          station_recommended_rank: 3,
          artist_bio: null,
        };
      }
      return Promise.resolve(entries);
    });
    mockAttachCriticReviews.mockImplementation((entries) => {
      // Shape mirrors `projectCriticReviewRow` in album-metadata-lookup.service.ts
      // exactly: `source` / `url` / `snippet` required, the rest omitted when
      // absent. camelCase `publishedDate` even though the parent entry's own
      // fields are snake_case — the schema is reused verbatim from the
      // `/proxy/metadata/album` response, and iOS's `TolerantCriticReviewItem`
      // requires `source` and `snippet` to be present or the item silently drops
      // to nil. An invented shape here would pin a dead feature.
      const first = entries[0];
      if (first) {
        first.critic_reviews = [
          {
            source: 'Pitchfork',
            url: 'https://pitchfork.example/painless',
            snippet: 'A restless, guitar-forward record that keeps its hooks half-buried.',
            author: 'A. Reviewer',
            publishedDate: '2022-03-04',
            rating: '7.8',
          },
        ];
      }
      return Promise.resolve(entries);
    });
  });

  it('serializes byte-for-byte to the checked-in golden', async () => {
    const payload = await getRecentEntries(50);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;

    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN_PATH, serialized);
      console.info(
        `[golden] wrote ${GOLDEN_PATH}\n[golden] sha256 = ${createHash('sha256').update(serialized).digest('hex')}\n` +
          '[golden] copy to wxyc-ios-64 Shared/Playlist/Tests/PlaylistTests/Fixtures/bs2103-enriched-payload.json ' +
          'and update GOLDEN_SHA256 in both suites.'
      );
      return;
    }

    const expected = readFileSync(GOLDEN_PATH, 'utf8');
    expect(serialized).toBe(expected);
  });

  it('matches the SHA-256 the iOS decode suite also asserts', () => {
    const actual = createHash('sha256').update(readFileSync(GOLDEN_PATH)).digest('hex');
    expect(actual).toBe(GOLDEN_SHA256);
  });

  // A byte-diff alone would let a rename slip through as "just a golden update",
  // so the two properties the shipped 3.2 binary actually depends on are also
  // asserted directly against the golden.

  it('emits no URL-typed key whose value is not an absolute http(s) URL', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    const urlKeys = [
      'artworkURL',
      'discogsURL',
      'spotifyURL',
      'appleMusicURL',
      'youtubeMusicURL',
      'bandcampURL',
      'soundcloudURL',
      'artistWikipediaURL',
    ];

    for (const playcut of golden.playcuts as Array<Record<string, unknown>>) {
      for (const [key, value] of Object.entries(playcut)) {
        if (!urlKeys.includes(key)) continue;
        expect(typeof value).toBe('string');
        const url = value as string;
        expect(url).toBe(url.trim());
        const parsed = new URL(url);
        expect(['http:', 'https:']).toContain(parsed.protocol);
        expect(parsed.hostname).not.toBe('');
      }
    }
  });

  it('drops every hazard the audit found, and keeps everything else', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    const byArtist = (name: string) => golden.playcuts.find((p: { artistName: string }) => p.artistName === name);

    // Label-prefixed junk: throws on the 3.2 decoder, so it must not ship.
    expect(byArtist('Hole')).not.toHaveProperty('artistWikipediaURL');
    expect(byArtist('Art Garfunkel')).not.toHaveProperty('artistWikipediaURL');
    // '' discogs sentinel (BS#1628).
    expect(byArtist('Jessica Pratt')).not.toHaveProperty('discogsURL');
    // Mislabeled streaming host (BS#1714) — the correct sibling survives.
    expect(byArtist('Chuquimamani-Condori')).not.toHaveProperty('spotifyURL');
    expect(byArtist('Chuquimamani-Condori').bandcampURL).toBe('https://chuquimamanicondori.bandcamp.com/album/dj-e');
    // Whitespace: padded is trimmed, blank is dropped.
    expect(byArtist('Juana Molina').discogsURL).toBe('https://www.discogs.com/release/999');
    expect(byArtist('Juana Molina')).not.toHaveProperty('artistWikipediaURL');
    // Non-web scheme, scheme-relative, bare host.
    expect(byArtist('Stereolab')).not.toHaveProperty('discogsURL');
    expect(byArtist('Stereolab')).not.toHaveProperty('spotifyURL');
    expect(byArtist('Stereolab')).not.toHaveProperty('bandcampURL');
    // Raw non-ASCII is NOT a hazard and must survive untouched.
    expect(byArtist('João Gilberto').artistWikipediaURL).toBe('http://en.wikipedia.org/wiki/João_Gilberto');
    expect(byArtist('Konono Nº1').artistWikipediaURL).toBe('https://en.wikipedia.org/wiki/Konono_Nº1');
    // A free-text play carries no URL key at all.
    const bare = byArtist('BS2103 Unenriched Artist');
    for (const key of ['artworkURL', 'discogsURL', 'spotifyURL', 'artistWikipediaURL']) {
      expect(bare).not.toHaveProperty(key);
    }
    expect(bare.metadataStatus).toBe('pending');
  });
});
