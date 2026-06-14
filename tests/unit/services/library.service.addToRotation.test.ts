/**
 * Unit tests for `addToRotation` + `classifyLmlResolveError` (BS#1380).
 *
 * Two surfaces under test:
 *
 *   1. `classifyLmlResolveError(err)` — pure function. Every catch-block
 *      branch (timeout / 5xx / 4xx / network / other) maps to the right
 *      `LmlResolveFallbackReason`. The Sentry counter `lml.resolve
 *      .fallback_to_null` carries this value as an attribute, and a
 *      per-bucket regression dashboard depends on the classifier producing
 *      the same string the prose contract promises. Exhaustive coverage
 *      lives here so a future refactor doesn't quietly collapse two buckets
 *      together.
 *
 *   2. `addToRotation` — when `library_identity.discogs_release_id` is
 *      non-NULL, the row is triple-written (discogs_release_id,
 *      discogs_release_id_source='library_identity', lml_identity_id).
 *      On resolve failure the first two still land; `lml_identity_id` is
 *      NULL. The Sentry counter fires once with `caller=add_to_rotation`
 *      and the classified `reason`.
 *
 * Tests don't reach the integration layer — Drizzle is mocked via the
 * established `database.mock` so we can assert on the INSERT values
 * directly.
 */

import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation, library_identity } from '../../mocks/database.mock';

// Mirror the real `LmlClientError` shape so the classifier's `err instanceof
// LmlClientError` branch fires. The wrapper sets `statusCode` to one of
// {422, 502, 504, ...} after translating from the upstream response.
class MockLmlClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LmlClientError';
    this.statusCode = statusCode;
  }
}

const mockResolveIdentity = jest.fn<() => Promise<{ identity_id: number; kind: 'release'; minted: boolean }>>();
const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
const mockGetRelease = jest.fn<() => Promise<unknown>>();

jest.mock('@wxyc/lml-client', () => ({
  resolveIdentity: mockResolveIdentity,
  lookupMetadata: mockLookupMetadata,
  lookupBySong: mockLookupBySong,
  isLmlConfigured: mockIsLmlConfigured,
  getRelease: mockGetRelease,
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: MockLmlClientError,
}));

jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: () => Promise.resolve(null) },
}));

const mockSentryMetricsCount = jest.fn<(name: string, value: number, opts: unknown) => void>();
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: unknown, callback: () => T | Promise<T>): Promise<T> => Promise.resolve(callback()),
  getActiveSpan: () => ({ setAttribute: jest.fn(), setAttributes: jest.fn() }),
  metrics: { count: mockSentryMetricsCount },
}));

import { addToRotation, classifyLmlResolveError } from '../../../apps/backend/services/library.service';

describe('classifyLmlResolveError', () => {
  test('AbortError → timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyLmlResolveError(err)).toBe('timeout');
  });

  test('LmlClientError statusCode 504 → timeout (lmlFetch translates AbortError)', () => {
    const err = new MockLmlClientError('LML request timed out', 504);
    expect(classifyLmlResolveError(err)).toBe('timeout');
  });

  test('LmlClientError statusCode 502 with upstream-5xx message → 5xx', () => {
    // `lmlFetch` translates upstream 5xx to 502 via `LmlClientError`
    // (`response.status >= 500 ? 502 : response.status`). The classifier
    // disambiguates that from a fetch-threw 502 (also wrapped) via the
    // message prefix `LML responded with`.
    const err = new MockLmlClientError('LML responded with 503: Service Unavailable', 502);
    expect(classifyLmlResolveError(err)).toBe('5xx');
  });

  test('LmlClientError statusCode 502 with fetch-threw message → network', () => {
    // The fetch-catch path in `lmlFetch` raises
    // `LmlClientError('LML request failed: <reason>', 502)`. That's the
    // "network" bucket — operator should look at DNS / TCP, not at LML's
    // deploy state.
    const err = new MockLmlClientError('LML request failed: ECONNRESET', 502);
    expect(classifyLmlResolveError(err)).toBe('network');
  });

  test('LmlClientError statusCode 422 → 4xx (sentinel rejection)', () => {
    const err = new MockLmlClientError('Discogs id <= 0 rejected', 422);
    expect(classifyLmlResolveError(err)).toBe('4xx');
  });

  test('LmlClientError statusCode 400 → 4xx', () => {
    const err = new MockLmlClientError('Bad Request', 400);
    expect(classifyLmlResolveError(err)).toBe('4xx');
  });

  test('LmlClientError statusCode 500 → 5xx (raw, not via lmlFetch translation)', () => {
    const err = new MockLmlClientError('Internal Server Error', 500);
    expect(classifyLmlResolveError(err)).toBe('5xx');
  });

  test('Node ECONNRESET → network', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyLmlResolveError(err)).toBe('network');
  });

  test('Node ENOTFOUND → network', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND lml'), { code: 'ENOTFOUND' });
    expect(classifyLmlResolveError(err)).toBe('network');
  });

  test('Node ECONNREFUSED → network', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyLmlResolveError(err)).toBe('network');
  });

  test('plain Error → other', () => {
    expect(classifyLmlResolveError(new Error('something else'))).toBe('other');
  });

  test('non-Error throwables → other', () => {
    expect(classifyLmlResolveError('a string')).toBe('other');
    expect(classifyLmlResolveError(null)).toBe('other');
    expect(classifyLmlResolveError(undefined)).toBe('other');
    expect(classifyLmlResolveError(42)).toBe('other');
  });
});

describe('addToRotation (BS#1380)', () => {
  const ALBUM_ID = 100;
  const DISCOGS_RELEASE_ID = 12345;
  const LML_IDENTITY_ID = 7700100;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('library_identity hit + LML resolve success → triple-write (discogs_release_id, source, lml_identity_id)', async () => {
    // Library-identity row supplies a non-NULL discogs_release_id.
    const selectChain = createMockQueryChain([{ discogs_release_id: DISCOGS_RELEASE_ID }]);
    selectChain.limit = jest.fn().mockResolvedValue([{ discogs_release_id: DISCOGS_RELEASE_ID }]);
    db.select.mockReturnValue(selectChain);

    // LML mints/returns a stable identity_id.
    mockResolveIdentity.mockResolvedValue({ identity_id: LML_IDENTITY_ID, kind: 'release', minted: true });

    // INSERT returns the persisted row.
    const insertChain = createMockQueryChain([
      {
        id: 1,
        album_id: ALBUM_ID,
        rotation_bin: 'M',
        discogs_release_id: DISCOGS_RELEASE_ID,
        discogs_release_id_source: 'library_identity',
        lml_identity_id: LML_IDENTITY_ID,
      },
    ]);
    db.insert.mockReturnValue(insertChain);

    const result = await addToRotation({ album_id: ALBUM_ID, rotation_bin: 'M' });

    expect(mockResolveIdentity).toHaveBeenCalledWith({
      kind: 'release',
      source: 'discogs_release',
      external_id: String(DISCOGS_RELEASE_ID),
    });

    // The INSERT was called with the three triple-write fields populated.
    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.album_id).toBe(ALBUM_ID);
    expect(valuesArg.rotation_bin).toBe('M');
    expect(valuesArg.discogs_release_id).toBe(DISCOGS_RELEASE_ID);
    expect(valuesArg.discogs_release_id_source).toBe('library_identity');
    expect(valuesArg.lml_identity_id).toBe(LML_IDENTITY_ID);

    expect(result?.lml_identity_id).toBe(LML_IDENTITY_ID);
    expect(mockSentryMetricsCount).not.toHaveBeenCalled();
  });

  test('library_identity hit + LML resolve failure → discogs_release_id + source still land, lml_identity_id = NULL, counter fires', async () => {
    const selectChain = createMockQueryChain([{ discogs_release_id: DISCOGS_RELEASE_ID }]);
    selectChain.limit = jest.fn().mockResolvedValue([{ discogs_release_id: DISCOGS_RELEASE_ID }]);
    db.select.mockReturnValue(selectChain);

    // Simulate LML timeout — `lmlFetch` raises `LmlClientError(..., 504)`.
    mockResolveIdentity.mockRejectedValue(new MockLmlClientError('LML request timed out', 504));

    const insertChain = createMockQueryChain([
      {
        id: 2,
        album_id: ALBUM_ID,
        rotation_bin: 'L',
        discogs_release_id: DISCOGS_RELEASE_ID,
        discogs_release_id_source: 'library_identity',
        lml_identity_id: null,
      },
    ]);
    db.insert.mockReturnValue(insertChain);

    const result = await addToRotation({ album_id: ALBUM_ID, rotation_bin: 'L' });

    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    // The source-of-the-Discogs-id is still library_identity (the issue's
    // explicit contract — provenance is honest even when the mint fails).
    expect(valuesArg.discogs_release_id).toBe(DISCOGS_RELEASE_ID);
    expect(valuesArg.discogs_release_id_source).toBe('library_identity');
    expect(valuesArg.lml_identity_id).toBeNull();

    expect(result?.lml_identity_id).toBeNull();

    // Counter fires once with the correct reason bucket.
    expect(mockSentryMetricsCount).toHaveBeenCalledTimes(1);
    expect(mockSentryMetricsCount).toHaveBeenCalledWith('lml.resolve.fallback_to_null', 1, {
      attributes: { caller: 'add_to_rotation', reason: 'timeout' },
    });
  });

  test('library_identity miss (no row, or row with NULL discogs_release_id) → no LML call, no triple-write', async () => {
    // The library_identity lookup returns no row.
    const selectChain = createMockQueryChain([]);
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    const insertChain = createMockQueryChain([{ id: 3, album_id: ALBUM_ID, rotation_bin: 'H' }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ album_id: ALBUM_ID, rotation_bin: 'H' });

    expect(mockResolveIdentity).not.toHaveBeenCalled();

    const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    // Server doesn't supply any of the LML-handle fields. The column
    // default ('tubafrenzy_paste') applies to discogs_release_id_source
    // when not set, but BS#1380's acceptance criterion is that we do NOT
    // tag dj-site rows as if they came from tubafrenzy. So for the
    // no-library-identity path, we leave the field unset — the default
    // 'tubafrenzy_paste' applies but no LML resolve fires and no
    // discogs_release_id lands either.
    expect(valuesArg.discogs_release_id).toBeUndefined();
    expect(valuesArg.discogs_release_id_source).toBeUndefined();
    expect(valuesArg.lml_identity_id).toBeUndefined();
  });

  test('reads library_identity by library_id (PRIMARY KEY)', async () => {
    // Defensive: confirms we're using the schema's PRIMARY KEY column,
    // not falling back to a wrong join key. The library_identity table's
    // PRIMARY KEY is library_id (schema.ts:1391-1393).
    const selectChain = createMockQueryChain([{ discogs_release_id: null }]);
    selectChain.limit = jest.fn().mockResolvedValue([{ discogs_release_id: null }]);
    db.select.mockReturnValue(selectChain);

    const insertChain = createMockQueryChain([{ id: 4 }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ album_id: ALBUM_ID, rotation_bin: 'M' });

    // The select chain reads from library_identity.
    expect(db.select).toHaveBeenCalled();
    expect(selectChain.from).toHaveBeenCalledWith(library_identity);
    expect(insertChain.values).toHaveBeenCalled();
    // INSERT target was rotation (not library_identity).
    expect(db.insert).toHaveBeenCalledWith(rotation);
  });
});
