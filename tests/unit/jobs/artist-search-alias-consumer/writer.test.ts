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
  // Mirror of `shared/database/src/normalize-artist-name.ts` (the
  // TS twin of the SQL `wxyc_schema.normalize_artist_name(text)`). The
  // mock factory cannot import the real module (the auto-mocker runs
  // before the file's top-level imports are evaluated), so we re-inline
  // the rule. Keep in sync if the canonical normalization changes.
  normalizeArtistName: (input: string | null | undefined): string => {
    const coalesced = input ?? '';
    return coalesced.replace(/^the[ \t\n\r\f\v]+/i, '').toLowerCase();
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

// Default canonical that does NOT normalize-collide with the default
// `variant()` fixture (`'Thee Oh Sees'`). Tests that exercise the no-op
// filter pass an explicit canonical (e.g. `'The Format'` for the
// BS#1382 leading-"The" subform).
const CANONICAL = 'Oh Sees';

describe('writeArtistVariants', () => {
  it('short-circuits with no transaction and no SQL when sourcesPresent is empty', async () => {
    const outcome = await writeArtistVariants(42, CANONICAL, [variant()], []);
    expect(mockTransaction).toHaveBeenCalledTimes(0);
    expect(mockExecute).toHaveBeenCalledTimes(0);
    expect(outcome.variants_written).toBe(0);
  });

  it('opens a transaction when sourcesPresent is non-empty', async () => {
    await writeArtistVariants(42, CANONICAL, [variant()], ['discogs_name_variation']);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('emits a single SQL statement (DELETE only) when variants is empty', async () => {
    await writeArtistVariants(42, CANONICAL, [], ['discogs_alias', 'wxyc_library_alt']);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('uses sql.join for the source list (anti-regression vs text[] literal)', async () => {
    await writeArtistVariants(42, CANONICAL, [], ['discogs_alias', 'wxyc_library_alt']);
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
    // Canonical 'Thee Oh Sees' so neither variant normalize-collides with
    // it ('OH SEES' lowercases to 'oh sees' which does not equal 'thee oh sees').
    await writeArtistVariants(42, 'Thee Oh Sees', variants, ['discogs_name_variation', 'discogs_alias']);
    // 1 DELETE + 2 INSERTs.
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it('uses sql.join twice in the non-empty-variants branch (source list and pair list)', async () => {
    await writeArtistVariants(
      42,
      'Thee Oh Sees',
      [variant(), variant({ variant: 'OH SEES' })],
      ['discogs_name_variation', 'discogs_alias']
    );
    // Both the source-list and the (source, variant)-pair list flow
    // through sql.join — that is the structural invariant of the
    // parameterised pattern.
    expect(sqlJoinCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('pre-stringifies last_verified_at (BS#802 drizzle Date trap)', async () => {
    // Canonical is distinct (normalization-wise) from 'Thee Oh Sees' so
    // the default variant isn't filtered out by the no-op-variant gate.
    await writeArtistVariants(42, 'Osees', [variant()], ['discogs_name_variation']);
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
      'Sinead OConnor',
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
    // Canonical 'Osees' so neither default variant ('Thee Oh Sees') nor
    // the two override variants ('OH SEES' / 'OHSEES') normalize-collide
    // with it. The no-op-variant gate is exercised in the BS#1382-tagged
    // cases below; this case checks the count-through behaviour.
    const variants = [variant(), variant({ variant: 'OH SEES' }), variant({ variant: 'OHSEES' })];
    const outcome = await writeArtistVariants(42, 'Osees', variants, ['discogs_name_variation']);
    expect(outcome.variants_written).toBe(3);
  });

  it('filters out blank-after-trim variants before INSERT (CHECK-violation rollback defense)', async () => {
    // `length(trim(variant)) > 0` is enforced by the substrate's CHECK
    // constraint; a single blank/whitespace variant rolls the whole
    // per-artist transaction back, dropping every other valid variant.
    // The most realistic source is a whitespace-only
    // library.alternate_artist_name surfacing via alt-name-source.ts
    // (which only filters IS NOT NULL). The writer pre-filters so one
    // bad row can't poison the whole run.
    const variants = [
      variant({ variant: 'Valid Name' }),
      variant({ variant: '   ' }), // blank-after-trim
      variant({ variant: '' }), // empty
      variant({ variant: '\t\n  ' }), // whitespace-only
      variant({ variant: 'Another Valid' }),
    ];
    const outcome = await writeArtistVariants(42, CANONICAL, variants, ['discogs_name_variation']);
    // Only the 2 valid variants reach the INSERT loop. 1 DELETE + 2 INSERTs.
    expect(outcome.variants_written).toBe(2);
    expect(mockExecute).toHaveBeenCalledTimes(3);
    // The blank variant strings must not appear as bound values.
    const allBinds = sqlTagCalls.flatMap((c) => c.values);
    expect(allBinds).not.toContain('   ');
    expect(allBinds).not.toContain('');
    expect(allBinds).not.toContain('\t\n  ');
  });

  it('coerces missing nullable fields (undefined) to SQL null — BS#1300 sparse-JSON regression', async () => {
    // LML emits sparse JSON for `discogs_name_variation` rows: the
    // upstream Discogs payload lacks the relationship columns
    // (`related_artist_id`, `external_subject_id`, `external_object_id`)
    // and the composer doesn't materialise them. `JSON.parse` of a
    // missing key produces `undefined`, not `null`. Drizzle's `sql` tag
    // interpolates `undefined` as an empty positional bind, producing
    // `VALUES (…, , …)` which Postgres rejects with a syntax error and
    // rolls the per-artist transaction back. Cost: 899 writer_errors
    // (~20%) on the 2026-06-03 first prod run.
    //
    // The writer must coerce every nullable interpolation through
    // `?? null` so the bind arrives at postgres-js as a JS `null`,
    // which binds to SQL NULL.
    const sparseVariant = {
      source: 'discogs_name_variation',
      variant: 'Sonic Yoof',
      method: 'name_variation',
      confidence: 0.95,
      // related_artist_id / external_subject_id / external_object_id / active
      // are absent — `v.x` is `undefined` at runtime.
    } as unknown as ArtistSearchAliasVariant;

    await writeArtistVariants(42, 'Sonic Youth', [sparseVariant], ['discogs_name_variation']);

    const allBinds = sqlTagCalls.flatMap((c) => c.values);
    // No `undefined` binds anywhere — every nullable slot must coerce
    // through `?? null` before reaching the sql tag.
    expect(allBinds).not.toContain(undefined);
    // The coerced nullable slots show up as `null` binds (one per
    // missing column).
    const nullBindCount = allBinds.filter((v) => v === null).length;
    expect(nullBindCount).toBeGreaterThanOrEqual(4);
  });

  it('falls back to DELETE-only when every variant is blank-after-trim (treats filtered-out as variants=[])', async () => {
    // If the only variants supplied are all blank, the writer should
    // behave as if variants=[] was passed: scoped DELETE, no INSERT.
    await writeArtistVariants(
      42,
      CANONICAL,
      [variant({ variant: '   ' }), variant({ variant: '' })],
      ['discogs_name_variation']
    );
    // Exactly one statement fires — the DELETE-only branch.
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // BS#1382 — substrate FP cleanup. The writer must reject no-op
  // `discogs_name_variation` rows whose normalized form equals the
  // canonical's normalized form. The audit (BS#1368 Path A) surfaced
  // "The Format" → "Format" and "The Snares" → "Snares" as the
  // leading-"The" subform; the rule is expressed against the shared
  // normalize function so any future expansion of the normalization key
  // (case-only, accent-only, etc.) covers automatically.
  // ---------------------------------------------------------------

  it("BS#1382 (leading-The subform): rejects discogs_name_variation row where the variant is the de-The'd canonical", async () => {
    // From the BS#1368 audit table: artist_id=260, canonical='The Format',
    // variant='Format' on source='discogs_name_variation'. Normalization
    // strips the leading "The " from both sides, so the variant adds zero
    // recall over the canonical row while actively colliding the
    // de-normalized form against a distinct library "Format".
    const variants = [
      variant({ source: 'discogs_name_variation', variant: 'Format' }),
      // A real synonym from a different source survives.
      variant({ source: 'discogs_alias', variant: 'The Formats', method: 'alias_curated', confidence: 0.85 }),
    ];
    const outcome = await writeArtistVariants(260, 'The Format', variants, ['discogs_name_variation', 'discogs_alias']);
    // Only the surviving variant is INSERTed; the DELETE still fires.
    expect(outcome.variants_written).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(2); // 1 DELETE + 1 INSERT
    const allBinds = sqlTagCalls.flatMap((c) => c.values);
    expect(allBinds).not.toContain('Format');
    expect(allBinds).toContain('The Formats');
  });

  it('BS#1382 (non-The norm-equivalent subform): rejects discogs_name_variation row whose only difference from the canonical collapses on normalization (case-only)', async () => {
    // The rule is general: any `discogs_name_variation` row whose
    // normalized form equals the canonical's normalized form is a no-op.
    // `normalize` lowercases, so "Stereolab" / "STEREOLAB" / "stereolab"
    // all collapse to the same key. This case locks in the generality of
    // the rule beyond the leading-"The" subform documented in the audit.
    const variants = [
      variant({ source: 'discogs_name_variation', variant: 'STEREOLAB' }),
      // A truly distinct name-variation survives.
      variant({ source: 'discogs_name_variation', variant: 'Stereo-Lab' }),
    ];
    const outcome = await writeArtistVariants(7, 'Stereolab', variants, ['discogs_name_variation']);
    expect(outcome.variants_written).toBe(1);
    const allBinds = sqlTagCalls.flatMap((c) => c.values);
    expect(allBinds).not.toContain('STEREOLAB');
    expect(allBinds).toContain('Stereo-Lab');
  });

  it('BS#1382: leaves `discogs_alias` / `discogs_member` / `wxyc_library_alt` rows untouched even if normalize-equivalent to canonical', async () => {
    // Only `discogs_name_variation` is gated. The other three sources
    // carry relational or curatorial signal that does not collapse on
    // normalization — a `discogs_alias` row pointing to the same name as
    // its canonical may still be a curated synonym worth preserving in
    // the substrate (and shape 2 — `discogs_member` — is the consumer-side
    // problem covered by #1383, not the substrate's). The writer must NOT
    // filter those.
    const variants = [
      variant({ source: 'discogs_alias', variant: 'Format', method: 'alias_curated', confidence: 0.85 }),
      variant({ source: 'discogs_member', variant: 'Format', method: 'member_group', confidence: 0.7 }),
      variant({ source: 'wxyc_library_alt', variant: 'Format', method: 'alt_curated', confidence: 0.85 }),
    ];
    const outcome = await writeArtistVariants(260, 'The Format', variants, [
      'discogs_alias',
      'discogs_member',
      'wxyc_library_alt',
    ]);
    // All three survive.
    expect(outcome.variants_written).toBe(3);
  });

  it('BS#1382: falls back to DELETE-only when the only variant is a no-op `discogs_name_variation`', async () => {
    // If the only variant for an artist is the no-op row, the writer
    // should reconcile away any stale row but emit no INSERT.
    await writeArtistVariants(
      20351,
      'The Snares',
      [variant({ source: 'discogs_name_variation', variant: 'Snares' })],
      ['discogs_name_variation']
    );
    // Exactly one statement fires — the DELETE-only branch.
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
