import { describe, it, expect } from '@jest/globals';
import {
  serializeCatalogNdjson,
  serializeCompilationTracksNdjson,
  type CatalogExportRow,
  type CompilationTrackExportRow,
} from '../../../apps/backend/services/catalog-export.service';

// BS#1468 — the bulk catalog export ships NDJSON (one JSON object per line) so a
// client can build/parse it incrementally. These tests pin the wire shape: the
// exact field set the iOS Spotlight clone consumes, and the NDJSON framing.
// BS#1965 extended CatalogExportRow with the four library.db-producer fields and
// added the sibling compilation-track (CTA) export.

const sampleRow = (overrides: Partial<CatalogExportRow> = {}): CatalogExportRow => ({
  id: 7000,
  legacy_release_id: 1_000_042,
  artist_name: 'Juana Molina',
  alternate_artist_name: null,
  album_artist: null,
  cross_reference_names: null,
  album_title: 'DOGA',
  code_letters: 'MO',
  code_number: 42,
  code_artist_number: 7,
  label: 'Sonamos',
  genre_name: 'Rock',
  format_name: 'CD',
  on_streaming: true,
  plays: 12,
  popularity: 17,
  artwork_url: 'https://example.test/doga.jpg',
  rotation_bin: 'H',
  rotation_kill_date: '2026-07-01',
  ...overrides,
});

describe('catalog-export.service: serializeCatalogNdjson', () => {
  it('emits one JSON object per line, each parsing back to the input row', () => {
    const rows = [sampleRow({ id: 1 }), sampleRow({ id: 2, artist_name: 'Jessica Pratt' })];

    const ndjson = serializeCatalogNdjson(rows);
    const lines = ndjson.split('\n').filter((l) => l.length > 0);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(rows[0]);
    expect(JSON.parse(lines[1])).toEqual(rows[1]);
  });

  it('emits exactly the 19 contract fields per line and excludes search_doc', () => {
    // The field set is the acceptance criterion for #1468 + the four BS#1965
    // library.db-producer fields. A row carrying an extra server-only field (e.g.
    // search_doc) must not leak into the export.
    const rowWithExtra = {
      ...sampleRow(),
      search_doc: 'juana molina doga sonamos',
      alphabetical_name: 'molina, juana',
    } as unknown as CatalogExportRow;

    const ndjson = serializeCatalogNdjson([rowWithExtra]);
    const parsed = JSON.parse(ndjson);

    expect(Object.keys(parsed).sort()).toEqual(
      [
        'album_artist',
        'album_title',
        'alternate_artist_name',
        'artist_name',
        'artwork_url',
        'code_artist_number',
        'code_letters',
        'code_number',
        'cross_reference_names',
        'format_name',
        'genre_name',
        'id',
        'label',
        'legacy_release_id',
        'on_streaming',
        'plays',
        'popularity',
        'rotation_bin',
        'rotation_kill_date',
      ].sort()
    );
    expect(parsed).not.toHaveProperty('search_doc');
    expect(parsed).not.toHaveProperty('alphabetical_name');
  });

  it('serializes an empty catalog to an empty string', () => {
    expect(serializeCatalogNdjson([])).toBe('');
  });

  it('preserves null rotation/streaming/popularity fields (album not in rotation, no logical popularity signal)', () => {
    // `popularity` is the only field whose null is a distinct contract value: it
    // ships raw-nullable (NOT COALESCEd to 0 like `plays`), so null must round-trip
    // as JSON null and not be dropped or coerced (BS#1486 Track 3 / SSOT #198).
    const row = sampleRow({
      rotation_bin: null,
      rotation_kill_date: null,
      on_streaming: null,
      plays: null,
      popularity: null,
    });
    const parsed = JSON.parse(serializeCatalogNdjson([row]));

    expect(parsed.rotation_bin).toBeNull();
    expect(parsed.rotation_kill_date).toBeNull();
    expect(parsed.on_streaming).toBeNull();
    expect(parsed.plays).toBeNull();
    expect(parsed).toHaveProperty('popularity', null);
  });

  it('round-trips the BS#1965 producer fields, keeping the nullable trio as JSON null when unset', () => {
    // legacy_release_id is required (non-null); the three curated free-text fields
    // are genuine library gaps and must ship as JSON null, not be dropped.
    const populated = sampleRow({
      legacy_release_id: 1_234_567,
      album_artist: 'Various',
      alternate_artist_name: 'V/A',
      cross_reference_names: 'Grouper | Liz Harris',
    });
    const parsedPopulated = JSON.parse(serializeCatalogNdjson([populated]));
    expect(parsedPopulated.legacy_release_id).toBe(1_234_567);
    expect(parsedPopulated.album_artist).toBe('Various');
    expect(parsedPopulated.alternate_artist_name).toBe('V/A');
    expect(parsedPopulated.cross_reference_names).toBe('Grouper | Liz Harris');

    const unset = sampleRow({ album_artist: null, alternate_artist_name: null, cross_reference_names: null });
    const parsedUnset = JSON.parse(serializeCatalogNdjson([unset]));
    expect(parsedUnset).toHaveProperty('album_artist', null);
    expect(parsedUnset).toHaveProperty('alternate_artist_name', null);
    expect(parsedUnset).toHaveProperty('cross_reference_names', null);
  });
});

describe('catalog-export.service: serializeCompilationTracksNdjson (BS#1965)', () => {
  const ctaRow = (overrides: Partial<CompilationTrackExportRow> = {}): CompilationTrackExportRow => ({
    legacy_release_id: 1_000_100,
    artist_name: 'Chuquimamani-Condori',
    track_title: 'Call Your Name',
    ...overrides,
  });

  it('emits one JSON object per line, each parsing back to the input row', () => {
    const rows = [ctaRow(), ctaRow({ artist_name: 'DJ E', track_title: 'Wayño' })];
    const lines = serializeCompilationTracksNdjson(rows)
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(rows[0]);
    expect(JSON.parse(lines[1])).toEqual(rows[1]);
  });

  it('emits exactly {legacy_release_id, artist_name, track_title} — no CTA id / track_position / library_id leak', () => {
    // library.db's CTA table is 3 columns; the row id, serial library_id, and
    // track_position must not ride along (parity + no internal-id leak).
    const rowWithExtra = {
      ...ctaRow(),
      id: 999,
      library_id: 7001,
      track_position: 'B2',
    } as unknown as CompilationTrackExportRow;
    const parsed = JSON.parse(serializeCompilationTracksNdjson([rowWithExtra]));
    expect(Object.keys(parsed).sort()).toEqual(['artist_name', 'legacy_release_id', 'track_title'].sort());
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('library_id');
    expect(parsed).not.toHaveProperty('track_position');
  });

  it('preserves a null track_title as JSON null', () => {
    const parsed = JSON.parse(serializeCompilationTracksNdjson([ctaRow({ track_title: null })]));
    expect(parsed).toHaveProperty('track_title', null);
  });

  it('serializes an empty CTA export to an empty string', () => {
    expect(serializeCompilationTracksNdjson([])).toBe('');
  });
});
