import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

// Pin the BS#1081 numeric-typing fix: the `cascade.query_word_count` attribute
// must be set at `Sentry.startSpan` creation time (via `attributes: {...}`)
// rather than via `setAttribute` after the span exists. If a future refactor
// regresses to `span.setAttribute('cascade.query_word_count', n)`, Sentry
// indexes the value as a string and breaks avg/p50/p90 aggregation on the
// post-deploy dashboards.

const mockRunCatalogTrackSearchCascade = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

jest.mock('../../../apps/backend/services/library.service', () => ({
  runCatalogTrackSearchCascade: mockRunCatalogTrackSearchCascade,
}));

type SpanLike = { setAttribute: jest.Mock; setAttributes: jest.Mock };
type SpanOpts = { name: string; op: string; attributes?: Record<string, unknown> };
const spanInstance: SpanLike = { setAttribute: jest.fn(), setAttributes: jest.fn() };
const mockStartSpan = jest.fn(
  <T>(_opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    Promise.resolve(callback(spanInstance))
);
jest.mock('@sentry/node', () => ({
  startSpan: <T>(opts: SpanOpts, callback: (span: SpanLike) => T | Promise<T>): Promise<T> =>
    mockStartSpan(opts, callback),
  getActiveSpan: () => spanInstance,
}));

import { searchLibrary } from '../../../apps/backend/services/library-search.service';

const PARAMS = {
  page: 0,
  limit: 20,
  sort: 'artist' as const,
  order: 'asc' as const,
};

function primeEmptyPrimary(): void {
  // Two `db.execute` calls in `searchLibrary` (data + count via Promise.all).
  // Empty data + total=0 forces the post-empty branch where the cascade gate
  // is consulted.
  db.execute.mockReset();
  db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
}

describe('searchLibrary catalog.cascade Sentry span (BS#1081 regression pin)', () => {
  beforeEach(() => {
    mockStartSpan.mockClear();
    mockRunCatalogTrackSearchCascade.mockClear();
  });

  it('passes cascade.query_word_count as numeric at startSpan creation', async () => {
    primeEmptyPrimary();

    await searchLibrary({ ...PARAMS, q: 'vi scose poise' });

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    const opts = mockStartSpan.mock.calls[0][0];
    expect(opts.name).toBe('catalog.cascade');
    expect(opts.op).toBe('catalog.cascade');
    const attrs = opts.attributes ?? {};
    expect(attrs).toEqual({ 'cascade.query_word_count': 3 });
    expect(typeof attrs['cascade.query_word_count']).toBe('number');
  });

  it('does not invoke startSpan or the cascade when the gate rejects (short query)', async () => {
    primeEmptyPrimary();

    await searchLibrary({ ...PARAMS, q: 'vi' });

    expect(mockStartSpan).not.toHaveBeenCalled();
    expect(mockRunCatalogTrackSearchCascade).not.toHaveBeenCalled();
  });

  it('does not invoke startSpan when the gate rejects (field-qualified)', async () => {
    primeEmptyPrimary();

    await searchLibrary({ ...PARAMS, q: 'artist:NonexistentArtistFoo' });

    expect(mockStartSpan).not.toHaveBeenCalled();
    expect(mockRunCatalogTrackSearchCascade).not.toHaveBeenCalled();
  });

  it('does not invoke startSpan on paginated requests (page > 0)', async () => {
    primeEmptyPrimary();

    await searchLibrary({ ...PARAMS, page: 1, q: 'vi scose poise' });

    expect(mockStartSpan).not.toHaveBeenCalled();
    expect(mockRunCatalogTrackSearchCascade).not.toHaveBeenCalled();
  });

  it('never falls back to setAttribute for the word-count attribute', async () => {
    primeEmptyPrimary();

    await searchLibrary({ ...PARAMS, q: 'vi scose poise' });

    const setAttributeKeys = spanInstance.setAttribute.mock.calls.map((c) => c[0]);
    const setAttributesKeys = spanInstance.setAttributes.mock.calls.flatMap((c) => Object.keys(c[0] as object));
    expect(setAttributeKeys).not.toContain('cascade.query_word_count');
    expect(setAttributesKeys).not.toContain('cascade.query_word_count');
  });
});
