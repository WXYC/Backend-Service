/**
 * Unit tests for writer.ts — reconcile + UPSERT one artist's alias variants.
 *
 * drizzle-orm's compiled exports don't expose `sql.join` cleanly under
 * ts-jest's transform, so the test mocks drizzle-orm with a stub that
 * tracks calls to `sql`, `sql.join`, and `sql.raw`. This lets us assert
 * the structural invariants of the writer without rendering full SQL:
 *
 *   - `sourcesPresent.length === 0` short-circuits (no transaction, no
 *     SQL). Empty sources_present means no composer leg ran; we cannot
 *     tell "deleted upstream" from "leg didn't fire" so leave the cache
 *     untouched.
 *   - `variants.length === 0` with non-empty `sourcesPresent`: emits one
 *     SQL statement (the scoped DELETE).
 *   - Non-empty variants: one DELETE + one INSERT per variant inside a
 *     transaction.
 *   - The implementation must call `sql.join` (anti-regression vs. the
 *     `'{${arr.join(',')}}'::text[]` literal pattern that silently
 *     corrupts comma- / quote-bearing variant strings — BS#1068-1073).
 *   - `last_verified_at` is pre-stringified — the bind passed for that
 *     slot must be an ISO-8601 string, never a JS Date (BS#802 trap).
 */

import { jest } from '@jest/globals';

const sqlJoinCalls: unknown[][] = [];
const sqlRawCalls: string[] = [];
type SqlTagCall = { strings?: string[]; values: unknown[] };
const sqlTagCalls: SqlTagCall[] = [];

jest.mock('drizzle-orm', () => {
  const sqlTag = (() => {
    const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      // Track every `sql\`...\`` invocation so the test can inspect the
      // bind values passed to the writer's template literals.
      sqlTagCalls.push({ strings: Array.from(strings), values });
      return { __sql: true, strings: Array.from(strings), values };
    }) as unknown as Record<string, unknown> & ((...args: unknown[]) => unknown);
    (fn as Record<string, unknown>).join = (...args: unknown[]) => {
      sqlJoinCalls.push(args);
      return { __sql: true, __join: true };
    };
    (fn as Record<string, unknown>).raw = (s: unknown) => {
      sqlRawCalls.push(typeof s === 'string' ? s : JSON.stringify(s));
      return { __sql: true, __raw: true };
    };
    return fn;
  })();
  return {
    sql: sqlTag,
  };
});

const mockExecute = jest.fn<() => Promise<unknown>>();
const mockTransaction = jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({ execute: mockExecute });
});

jest.mock('@wxyc/database', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...(args as [(tx: unknown) => Promise<void>])),
    execute: mockExecute,
  },
}));

import type { ArtistSearchAliasVariant } from '../../../../jobs/artist-search-alias-consumer/lml-types';
import { writeArtistVariants } from '../../../../jobs/artist-search-alias-consumer/writer';

const variant = (overrides: Partial<ArtistSearchAliasVariant> = {}): ArtistSearchAliasVariant => ({
  source: 'discogs_name_variation',
  variant: 'Thee Oh Sees',
  method: 'name_variation',
  confidence: 0.95,
  related_artist_id: null,
  external_subject_id: null,
  external_object_id: null,
  active: null,
  ...overrides,
});

beforeEach(() => {
  sqlJoinCalls.length = 0;
  sqlRawCalls.length = 0;
  sqlTagCalls.length = 0;
  mockExecute.mockReset();
  mockExecute.mockResolvedValue(undefined);
  mockTransaction.mockClear();
});

describe('writeArtistVariants', () => {
  it('short-circuits with no transaction and no SQL when sourcesPresent is empty', async () => {
    const outcome = await writeArtistVariants(42, [variant()], []);
    expect(mockTransaction).toHaveBeenCalledTimes(0);
    expect(mockExecute).toHaveBeenCalledTimes(0);
    expect(outcome.variants_written).toBe(0);
  });

  it('opens a transaction when sourcesPresent is non-empty', async () => {
    await writeArtistVariants(42, [variant()], ['discogs_name_variation']);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('emits a single SQL statement (DELETE only) when variants is empty', async () => {
    await writeArtistVariants(42, [], ['discogs_alias', 'wxyc_library_alt']);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('uses sql.join for the source list (anti-regression vs text[] literal)', async () => {
    await writeArtistVariants(42, [], ['discogs_alias', 'wxyc_library_alt']);
    // sql.join is the parameterized-VALUES helper; if the writer ever
    // regressed to building a `'{${arr.join(",")}}'::text[]` literal,
    // sql.join would never be called.
    expect(sqlJoinCalls.length).toBeGreaterThan(0);
  });

  it('issues one INSERT per variant plus one scoped DELETE when variants is non-empty', async () => {
    const variants = [
      variant({ source: 'discogs_name_variation', variant: 'OH SEES' }),
      variant({ source: 'discogs_alias', variant: 'Oh Sees', method: 'alias_curated', confidence: 0.85 }),
    ];
    await writeArtistVariants(42, variants, ['discogs_name_variation', 'discogs_alias']);
    // 1 DELETE + 2 INSERTs.
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it('uses sql.join twice in the non-empty-variants branch (source list and pair list)', async () => {
    await writeArtistVariants(
      42,
      [variant(), variant({ variant: 'OH SEES' })],
      ['discogs_name_variation', 'discogs_alias']
    );
    // Both the source-list and the (source, variant)-pair list flow
    // through sql.join — that is the structural invariant of the
    // parameterised pattern.
    expect(sqlJoinCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('pre-stringifies last_verified_at (BS#802 drizzle Date trap)', async () => {
    await writeArtistVariants(42, [variant()], ['discogs_name_variation']);
    // Inspect every captured `sql\`...\`` call's bind values. The
    // last_verified_at slot is the only timestamp-shaped bind in the
    // INSERT; it must be a string, never a Date.
    const allBinds = sqlTagCalls.flatMap((c) => c.values);
    const hasDate = allBinds.some((v) => v instanceof Date);
    expect(hasDate).toBe(false);
    const hasIsoString = allBinds.some((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v));
    expect(hasIsoString).toBe(true);
  });

  it('binds the artist_id, source, and variant text as positional params', async () => {
    await writeArtistVariants(
      42,
      [variant({ source: 'discogs_alias', variant: "Sinéad O'Connor" })],
      ['discogs_alias']
    );
    const allBinds = sqlTagCalls.flatMap((c) => c.values);
    // The artist_id, source, and variant text must each appear as bound
    // values somewhere in the captured SQL — not as inlined SQL string
    // segments (which is the failure mode of the rejected array-literal
    // pattern).
    expect(allBinds).toContain(42);
    expect(allBinds).toContain('discogs_alias');
    expect(allBinds).toContain("Sinéad O'Connor");
  });

  it('returns variants_written equal to the variants supplied (when sourcesPresent is non-empty)', async () => {
    const variants = [variant(), variant({ variant: 'OH SEES' }), variant({ variant: 'OHSEES' })];
    const outcome = await writeArtistVariants(42, variants, ['discogs_name_variation']);
    expect(outcome.variants_written).toBe(3);
  });
});
