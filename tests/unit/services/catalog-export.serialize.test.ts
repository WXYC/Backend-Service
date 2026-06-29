import { describe, it, expect } from '@jest/globals';
import { serializeCatalogNdjson, type CatalogExportRow } from '../../../apps/backend/services/catalog-export.service';

// BS#1468 — the bulk catalog export ships NDJSON (one JSON object per line) so a
// client can build/parse it incrementally. These tests pin the wire shape: the
// exact field set the iOS Spotlight clone consumes, and the NDJSON framing.

const sampleRow = (overrides: Partial<CatalogExportRow> = {}): CatalogExportRow => ({
  id: 7000,
  artist_name: 'Juana Molina',
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

  it('emits exactly the 15 contract fields per line and excludes search_doc', () => {
    // The field set is the acceptance criterion for #1468. A row carrying an
    // extra server-only field (e.g. search_doc) must not leak into the export.
    const rowWithExtra = {
      ...sampleRow(),
      search_doc: 'juana molina doga sonamos',
      alphabetical_name: 'molina, juana',
    } as unknown as CatalogExportRow;

    const ndjson = serializeCatalogNdjson([rowWithExtra]);
    const parsed = JSON.parse(ndjson);

    expect(Object.keys(parsed).sort()).toEqual(
      [
        'album_title',
        'artist_name',
        'artwork_url',
        'code_artist_number',
        'code_letters',
        'code_number',
        'format_name',
        'genre_name',
        'id',
        'label',
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
});
