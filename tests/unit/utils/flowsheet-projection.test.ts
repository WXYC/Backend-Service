import {
  projectFlowsheetEntry,
  pickClientFacingColumns,
  CLIENT_FACING_FLOWSHEET_COLUMNS,
} from '../../../apps/backend/utils/flowsheet-projection';
import { INTERNAL_FLOWSHEET_COLUMNS, makeFullFlowsheetRow } from '../../fixtures/flowsheet-row.fixture';

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
});
