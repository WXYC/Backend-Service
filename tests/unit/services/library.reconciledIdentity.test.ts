/**
 * Unit tests for the artist response serializer that attaches a nested
 * `reconciled_identity` field conforming to the @wxyc/shared schema.
 */

// The service module imports drizzle and DB internals at top level. None of
// our tests touch the DB; mock the @wxyc/database package surface so the
// import chain doesn't require live SQL clients.
jest.mock('@wxyc/database', () => ({
  db: {},
  artists: {},
  genre_artist_crossreference: {},
  format: {},
  genres: {},
  library: {},
  library_artist_view: {},
  rotation: {},
}));

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: jest.fn(),
  isLmlConfigured: jest.fn().mockReturnValue(false),
}));

jest.mock('../../../apps/backend/services/requestLine/types', () => ({
  enrichLibraryResult: jest.fn(),
}));

jest.mock('../../../apps/backend/services/requestLine/matching/index', () => ({
  extractSignificantWords: jest.fn(),
}));

import type { Artist, LibraryArtistViewEntry } from '@wxyc/database';
import {
  serializeArtist,
  serializeLibraryArtistViewEntry,
  toReconciledIdentity,
} from '../../../apps/backend/services/library.service';

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    id: 1,
    artist_name: 'Stereolab',
    alphabetical_name: 'Stereolab',
    code_letters: 'S',
    add_date: '2026-01-01',
    last_modified: new Date('2026-01-01T00:00:00Z'),
    discogs_artist_id: null,
    musicbrainz_artist_id: null,
    wikidata_qid: null,
    spotify_artist_id: null,
    apple_music_artist_id: null,
    bandcamp_id: null,
    ...overrides,
  };
}

describe('toReconciledIdentity', () => {
  test('returns null when all six external-ID fields are null', () => {
    expect(toReconciledIdentity(makeArtist())).toBeNull();
  });

  test('returns a populated object when at least one ID is set', () => {
    const identity = toReconciledIdentity(
      makeArtist({
        discogs_artist_id: 388,
        wikidata_qid: 'Q650826',
      })
    );

    expect(identity).not.toBeNull();
    expect(identity!.discogs_artist_id).toBe(388);
    expect(identity!.wikidata_qid).toBe('Q650826');
    // Unset fields are explicitly null on the nested object so consumers can
    // rely on key presence.
    expect(identity!.musicbrainz_artist_id).toBeNull();
    expect(identity!.spotify_artist_id).toBeNull();
    expect(identity!.apple_music_artist_id).toBeNull();
    expect(identity!.bandcamp_id).toBeNull();
  });

  test('returns all six fields when fully reconciled', () => {
    const identity = toReconciledIdentity(
      makeArtist({
        discogs_artist_id: 388,
        musicbrainz_artist_id: '4ab1437f-2cb7-46c1-a55e-7d5b0a2b4d5c',
        wikidata_qid: 'Q650826',
        spotify_artist_id: '4uSftVc3FPWe6RJuMZNEe9',
        apple_music_artist_id: '88495919',
        bandcamp_id: 'stereolab',
      })
    );

    expect(identity).toEqual({
      discogs_artist_id: 388,
      musicbrainz_artist_id: '4ab1437f-2cb7-46c1-a55e-7d5b0a2b4d5c',
      wikidata_qid: 'Q650826',
      spotify_artist_id: '4uSftVc3FPWe6RJuMZNEe9',
      apple_music_artist_id: '88495919',
      bandcamp_id: 'stereolab',
    });
  });
});

describe('serializeArtist', () => {
  test('strips the six flat external-ID columns from the wire shape', () => {
    const wire = serializeArtist(
      makeArtist({
        discogs_artist_id: 388,
        spotify_artist_id: '4uSftVc3FPWe6RJuMZNEe9',
      })
    );

    expect(wire).not.toHaveProperty('discogs_artist_id');
    expect(wire).not.toHaveProperty('musicbrainz_artist_id');
    expect(wire).not.toHaveProperty('wikidata_qid');
    expect(wire).not.toHaveProperty('spotify_artist_id');
    expect(wire).not.toHaveProperty('apple_music_artist_id');
    expect(wire).not.toHaveProperty('bandcamp_id');
  });

  test('preserves the non-identity columns from the row', () => {
    const wire = serializeArtist(
      makeArtist({
        id: 42,
        artist_name: 'Juana Molina',
        alphabetical_name: 'Molina, Juana',
        code_letters: 'MO',
      })
    );

    expect(wire.id).toBe(42);
    expect(wire.artist_name).toBe('Juana Molina');
    expect(wire.alphabetical_name).toBe('Molina, Juana');
    expect(wire.code_letters).toBe('MO');
  });

  test('attaches a populated reconciled_identity when at least one ID is set', () => {
    const wire = serializeArtist(makeArtist({ bandcamp_id: 'juanamolina' }));

    expect(wire.reconciled_identity).toEqual({
      discogs_artist_id: null,
      musicbrainz_artist_id: null,
      wikidata_qid: null,
      spotify_artist_id: null,
      apple_music_artist_id: null,
      bandcamp_id: 'juanamolina',
    });
  });

  test('attaches reconciled_identity=null for an unreconciled artist', () => {
    const wire = serializeArtist(makeArtist());

    expect(wire.reconciled_identity).toBeNull();
  });
});

function makeViewRow(overrides: Partial<LibraryArtistViewEntry> = {}): LibraryArtistViewEntry {
  return {
    id: 100,
    code_letters: 'JM',
    code_artist_number: 1,
    code_number: 2,
    artist_name: 'Juana Molina',
    alphabetical_name: 'Molina, Juana',
    album_title: 'DOGA',
    format_name: 'CD',
    genre_name: 'Rock',
    rotation_bin: null,
    add_date: new Date('2026-01-01T00:00:00Z'),
    label: 'Sonamos',
    label_id: 1,
    on_streaming: true,
    album_artist: null,
    plays: 5,
    artwork_url: null,
    discogs_artist_id: null,
    musicbrainz_artist_id: null,
    wikidata_qid: null,
    spotify_artist_id: null,
    apple_music_artist_id: null,
    bandcamp_id: null,
    ...overrides,
  };
}

describe('serializeLibraryArtistViewEntry', () => {
  test('strips the six flat external-ID columns and attaches a nested reconciled_identity', () => {
    const wire = serializeLibraryArtistViewEntry(
      makeViewRow({
        discogs_artist_id: 50872,
        spotify_artist_id: '5C3wCMlqocoBs4riK9DnUq',
      })
    );

    expect(wire).not.toHaveProperty('discogs_artist_id');
    expect(wire).not.toHaveProperty('musicbrainz_artist_id');
    expect(wire).not.toHaveProperty('wikidata_qid');
    expect(wire).not.toHaveProperty('spotify_artist_id');
    expect(wire).not.toHaveProperty('apple_music_artist_id');
    expect(wire).not.toHaveProperty('bandcamp_id');

    expect(wire.reconciled_identity).toEqual({
      discogs_artist_id: 50872,
      musicbrainz_artist_id: null,
      wikidata_qid: null,
      spotify_artist_id: '5C3wCMlqocoBs4riK9DnUq',
      apple_music_artist_id: null,
      bandcamp_id: null,
    });
  });

  test('preserves view-specific columns (album_title, plays, etc.)', () => {
    const wire = serializeLibraryArtistViewEntry(makeViewRow({ id: 99, album_title: 'Halo', plays: 12 }));

    expect(wire.id).toBe(99);
    expect(wire.album_title).toBe('Halo');
    expect(wire.plays).toBe(12);
  });

  test('returns reconciled_identity=null for a view row whose artist is unreconciled', () => {
    const wire = serializeLibraryArtistViewEntry(makeViewRow());
    expect(wire.reconciled_identity).toBeNull();
  });
});
