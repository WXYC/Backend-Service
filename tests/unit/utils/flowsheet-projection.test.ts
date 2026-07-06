import {
  projectFlowsheetEntry,
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
    // Deliberate deviation from #1513's AC wording (PR #1532 review):
    // `FlowsheetEntryResponse` in wxyc-shared/api.yaml declares metadata_status
    // on the documented 200 of all four mutation endpoints, transformToV2
    // emits it on V2 track reads for iOS branch logic (wxyc-ios-64#270), and
    // LiveFsUpdateEvent requires it. The internal aspect is write-protection
    // (pickUpdateEntryFields blocks clients from SETTING it), not read
    // visibility.
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
