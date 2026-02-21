let selectCallCount = 0;
const selectSpy = jest.fn();
const queryResults: unknown[][] = [];

function createChain(resolveIndex: number) {
  const resolver = () => queryResults[resolveIndex] ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (onFulfill: (v: unknown) => unknown, onReject?: (e: unknown) => unknown) =>
    Promise.resolve(resolver()).then(onFulfill, onReject);
  return chain;
}

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => {
      selectSpy(...args);
      return createChain(selectCallCount++);
    },
  },
  show_djs: { dj_id: 'dj_id', show_id: 'show_id' },
  shows: { id: 'id', specialty_id: 'specialty_id' },
  specialty_shows: { id: 'id', specialty_name: 'specialty_name' },
  flowsheet: { show_id: 'show_id', message: 'message' },
  user: { id: 'id', djName: 'djName' },
  bins: {},
  library: {},
  artists: {},
  format: {},
  genres: {},
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  and: jest.fn((...args: unknown[]) => ({ and: args })),
  isNull: jest.fn((col) => ({ isNull: col })),
  inArray: jest.fn((col, vals) => ({ inArray: [col, vals] })),
}));

import { getPlaylistsForDJ } from '../../../apps/backend/services/djs.service';

const DJ_ID = 'dj-1';

function makeShowDjRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    show_id: i + 1,
    dj_id: DJ_ID,
    active: true,
  }));
}

function makeShowRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    primary_dj_id: DJ_ID,
    specialty_id: i === 0 ? 10 : null,
    show_name: `Show ${i + 1}`,
    start_time: new Date(`2024-01-${String(i + 1).padStart(2, '0')}T20:00:00Z`),
    end_time: null,
  }));
}

function makeDjsForShows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    dj_id: DJ_ID,
    dj_name: 'DJ One',
    show_id: i + 1,
  }));
}

function makeFlowsheetRows(showCount: number) {
  const entries = [];
  for (let s = 0; s < showCount; s++) {
    for (let e = 0; e < 4; e++) {
      entries.push({
        id: s * 4 + e + 1,
        show_id: s + 1,
        album_id: null,
        rotation_id: null,
        entry_type: 'track',
        track_title: `Track ${e + 1}`,
        album_title: `Album ${e + 1}`,
        artist_name: `Artist ${e + 1}`,
        record_label: null,
        play_order: e + 1,
        request_flag: false,
        message: null,
        add_time: new Date(),
      });
    }
  }
  return entries;
}

describe('djs.service - getPlaylistsForDJ', () => {
  beforeEach(() => {
    selectCallCount = 0;
    selectSpy.mockClear();
    queryResults.length = 0;
  });

  const NUM_SHOWS = 5;
  const MAX_ALLOWED_SELECTS = 6;

  it(`should make at most ${MAX_ALLOWED_SELECTS} select() calls, not O(N) for ${NUM_SHOWS} shows`, async () => {
    const showDjRows = makeShowDjRows(NUM_SHOWS);
    const showRows = makeShowRows(NUM_SHOWS);
    const djRows = makeDjsForShows(NUM_SHOWS);
    const specialtyRows = [{ id: 10, specialty_name: 'Jazz After Hours' }];
    const flowsheetRows = makeFlowsheetRows(NUM_SHOWS);

    // Provide enough results for both the batched (5 queries) and N+1 (17+ queries) paths.
    // Batched order: [showDjs, shows, allDjs, specialties, flowsheet]
    // N+1 order: [showDjs, show1, djs1, specialty1, fs1, show2, djs2, fs2, ...]
    // We fill enough slots so either code path can run without crashing.
    queryResults.push(showDjRows);                // 0: show_djs for DJ
    queryResults.push(showRows);                  // 1: batched shows / N+1 show[0]
    queryResults.push(djRows);                    // 2: batched djs / N+1 djs[0]
    queryResults.push(specialtyRows);             // 3: batched specialty / N+1 specialty[0]
    queryResults.push(flowsheetRows);             // 4: batched flowsheet / N+1 flowsheet[0]
    // Extra slots for N+1 loop iterations (shows 2-5)
    for (let i = 1; i < NUM_SHOWS; i++) {
      queryResults.push([showRows[i]]);           // show
      queryResults.push([{ dj_id: DJ_ID, dj_name: 'DJ One' }]); // djs
      if (showRows[i].specialty_id != null) {
        queryResults.push(specialtyRows);
      }
      queryResults.push(flowsheetRows.filter((e) => e.show_id === i + 1)); // flowsheet
    }

    await getPlaylistsForDJ(DJ_ID);

    const totalSelectCalls = selectSpy.mock.calls.length;
    expect(totalSelectCalls).toBeLessThanOrEqual(MAX_ALLOWED_SELECTS);
  });

  it('returns correct ShowPeek structures', async () => {
    const showDjRows = makeShowDjRows(2);
    const showRows = makeShowRows(2);
    const djRows = makeDjsForShows(2);
    const specialtyRows = [{ id: 10, specialty_name: 'Jazz After Hours' }];
    const flowsheetRows = makeFlowsheetRows(2);

    queryResults.push(showDjRows);
    queryResults.push(showRows);
    queryResults.push(djRows);
    queryResults.push(specialtyRows);
    queryResults.push(flowsheetRows);
    // N+1 fallback slots
    queryResults.push([showRows[1]]);
    queryResults.push([{ dj_id: DJ_ID, dj_name: 'DJ One' }]);
    queryResults.push(flowsheetRows.filter((e) => e.show_id === 2));

    const result = await getPlaylistsForDJ(DJ_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('show');
    expect(result[0]).toHaveProperty('show_name');
    expect(result[0]).toHaveProperty('date');
    expect(result[0]).toHaveProperty('djs');
    expect(result[0]).toHaveProperty('specialty_show');
    expect(result[0]).toHaveProperty('preview');
  });
});
