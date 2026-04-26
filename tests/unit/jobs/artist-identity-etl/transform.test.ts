import {
  columnsInConflict,
  columnsToFill,
  type ExistingArtistIdentity,
} from '../../../../jobs/artist-identity-etl/transform';
import type { LmlIdentity } from '../../../../jobs/artist-identity-etl/fetch-lml';

const baseExisting: ExistingArtistIdentity = {
  artist_name: 'Stereolab',
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  wikidata_qid: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
};

const baseLml: LmlIdentity = {
  library_name: 'Stereolab',
  discogs_artist_id: null,
  wikidata_qid: null,
  musicbrainz_artist_id: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
};

describe('columnsToFill', () => {
  test('returns the columns where existing is null and LML has a value', () => {
    const fills = columnsToFill(baseExisting, {
      ...baseLml,
      discogs_artist_id: 388,
      wikidata_qid: 'Q650826',
    });
    expect(fills.sort()).toEqual(['discogs_artist_id', 'wikidata_qid']);
  });

  test('returns an empty list when LML has nothing new', () => {
    const fills = columnsToFill(baseExisting, baseLml);
    expect(fills).toEqual([]);
  });

  test('skips columns where the existing value is already set (never overwrite)', () => {
    const fills = columnsToFill(
      { ...baseExisting, discogs_artist_id: 999 },
      { ...baseLml, discogs_artist_id: 388, wikidata_qid: 'Q650826' }
    );
    expect(fills).toEqual(['wikidata_qid']);
  });

  test('skips columns where LML supplies null', () => {
    const fills = columnsToFill(baseExisting, { ...baseLml, discogs_artist_id: 388 });
    expect(fills).toEqual(['discogs_artist_id']);
  });
});

describe('columnsInConflict', () => {
  test('returns columns where both sides have a value but they differ', () => {
    const conflicts = columnsInConflict(
      { ...baseExisting, discogs_artist_id: 999, spotify_artist_id: 'a' },
      { ...baseLml, discogs_artist_id: 388, spotify_artist_id: 'a' }
    );
    expect(conflicts).toEqual(['discogs_artist_id']);
  });

  test('returns an empty list when no conflicts exist', () => {
    expect(columnsInConflict(baseExisting, baseLml)).toEqual([]);
    expect(
      columnsInConflict({ ...baseExisting, discogs_artist_id: 388 }, { ...baseLml, discogs_artist_id: 388 })
    ).toEqual([]);
  });

  test('does not flag columns where one side is null', () => {
    expect(columnsInConflict({ ...baseExisting, discogs_artist_id: 388 }, baseLml)).toEqual([]);
    expect(columnsInConflict(baseExisting, { ...baseLml, discogs_artist_id: 388 })).toEqual([]);
  });
});
