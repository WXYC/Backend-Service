/**
 * Candidate query + resolver for jobs/concerts-artist-resolver (BS#1372).
 *
 * `loadCandidates` selects `concerts` rows that still need a canonical
 * artist FK: `headlining_artist_id IS NULL AND headlining_artist_raw IS
 * NOT NULL`. The `IS NULL` half is the idempotency gate — rerunning the
 * job picks up only still-unresolved rows; resolved rows are never
 * re-examined.
 *
 * `resolveArtistId` is the strict-then-alias resolver. Strict and alias
 * arms each run a separate SQL JOIN. The CTE keeps the normalization
 * call once per side, so the functional index from migration 0092 can
 * drive the lookup. Multiple artists with the same normalized name
 * collapse to `kind: 'ambiguous'`; alias matches dedup on `artist_id`
 * before the same singleton check so multiple variants of the same
 * canonical artist count as one match.
 *
 * Strict-wins: if the strict arm returns exactly one canonical match,
 * we write that and never invoke the alias arm. The alias arm only
 * fires when strict returns zero matches.
 *
 * Schema-qualified table refs honour `WXYC_SCHEMA_NAME` (parallel Jest
 * workers override the var so each worker targets its own schema).
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { Candidate, ResolveFn, ResolveOutcome } from './orchestrate.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const ARTIST_SEARCH_ALIAS_TABLE = sql.raw(`"${SCHEMA}"."artist_search_alias"`);
const NORMALIZE_FN = sql.raw(`"${SCHEMA}"."normalize_artist_name"`);

/**
 * `artist_search_alias.source` partitions into two classes (BS#1383).
 * The resolver is the partition's owner: it decides which sources are
 * eligible to drive an FK write. Tests import these constants directly
 * so the SQL IN-list and the test fixtures cannot drift.
 *
 *   - SYNONYM_ALIAS_SOURCES name the same artist by another spelling
 *     and are safe to fold into the FK-write path — that's the alias
 *     substrate's whole point.
 *   - RELATIONAL_ALIAS_SOURCES express "X is related to Y" (member
 *     of, collaborator, etc.) and are NOT safe — they produce
 *     mislabels like the Geordie Greep → black midi case from the
 *     BS#1368 audit.
 *
 * Adding a 5th LML source requires a deliberate choice here. The
 * resolver's SQL IN-list is built from SYNONYM_ALIAS_SOURCES, so a
 * source the partition does not name is silently excluded (safe-by-
 * default: FK stays NULL, row drops to manual review). The catalog-
 * search sites do not consult these constants — they propagate
 * `source` to callers so iOS / dj-site can render relational hits
 * differently (e.g., "related artist") with full source context.
 *
 * Drift hazard (tracked by BS#1390): the `ArtistSearchAliasSource`
 * type union lives in three other places — lml-types.ts,
 * requestLine/types.ts, orchestrate.test.ts — none of which import
 * from each other or from these constants. BS#1390 consolidates them
 * around this partition; the matching SynonymAliasSource /
 * RelationalAliasSource types will be exported from here at that time.
 */
export const SYNONYM_ALIAS_SOURCES = ['discogs_name_variation', 'discogs_alias', 'wxyc_library_alt'] as const;
export const RELATIONAL_ALIAS_SOURCES = ['discogs_member'] as const;

/**
 * Frozen IN-list for the alias arm, built once at module load. Safe-
 * by-construction: the partition is immutable and the values are
 * compile-time constants we control. The identifier-charset assumption
 * (`[A-Za-z0-9_]+`, Postgres' own convention) that lets us inline-
 * quote without escaping is pinned by the unit test
 * `SYNONYM_ALIAS_SOURCES values are identifier-safe` in
 * query.test.ts — runtime validation would just crash-loop the
 * container at deploy with a bare Node stack, before Sentry / logger /
 * safeFinalize get a chance to attribute the failure, so the
 * gatekeeping lives in CI instead.
 *
 * `sql.raw` is the simplest assembly here because the values are a
 * closed const tuple. `sql.join` would also work and is the project's
 * default for parameterised lists (see
 * `jobs/artist-search-alias-consumer/writer.ts` for the canonical
 * runtime usage with comma-bearing variant strings); the only reason
 * to prefer `sql.raw` for this site is that `sql.join` requires
 * mocking drizzle-orm in unit tests (the writer's test does this),
 * which is overkill for a 3-element identifier-safe tuple.
 */
const SYNONYM_SOURCE_IN_LIST = sql.raw(SYNONYM_ALIAS_SOURCES.map((s) => `'${s}'`).join(', '));

type IdRow = { artist_id: number };

/**
 * Normalize `db.execute(sql\`...\`)` results across drizzle-orm driver
 * shapes. postgres-js returns an array; node-postgres returns `{ rows }`.
 * Anything else means the driver contract changed under us, in which
 * case we want a LOUD failure — a silent `[]` fallback would turn the
 * job into a healthy-looking zero-work no-op (counters all 0, dashboards
 * green) while real candidates pile up unresolved.
 */
const describeShape = (result: unknown): string => {
  if (result === null) return 'null';
  if (result === undefined) return 'undefined';
  if (typeof result !== 'object') return typeof result;
  return `object{${Object.keys(result).join(',')}}`;
};

const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`concerts-artist-resolver: unrecognized db.execute() result shape: ${describeShape(result)}`);
};

/**
 * Volume assumption: ~16 venues × ~10 shows/wk × 52 wk ≈ ~8k rows/yr,
 * but steady-state the SELECT returns only the unresolved tail (most
 * rows have a FK). Pulling the full eligible set into memory is fine at
 * current scale; if the substrate expands (new sources, a one-time
 * resolver-rule change requires a re-drain), revisit with id-cursor
 * batching à la `jobs/library-identity-consumer/select.ts`.
 */
export const loadCandidates = async (): Promise<Candidate[]> => {
  const result: unknown = await db.execute(sql`
    SELECT "id", "headlining_artist_raw"
    FROM ${CONCERTS_TABLE}
    WHERE "headlining_artist_id" IS NULL
      AND "headlining_artist_raw" IS NOT NULL
    ORDER BY "id" ASC
  `);
  return unwrapRows<Candidate>(result);
};

export const resolveArtistId: ResolveFn = async (raw: string): Promise<ResolveOutcome> => {
  // No DISTINCT: `artists.id` is the PK so the result set is already
  // unique. DISTINCT here would force a Unique node on top of the
  // IndexScan against `artists_normalized_name_idx` and inhibit
  // `LIMIT 2` pushdown. The alias arm below DOES need DISTINCT —
  // `artist_search_alias.artist_id` is non-unique by design (multiple
  // variants per artist).
  const strict: unknown = await db.execute(sql`
    SELECT a."id" AS artist_id
    FROM ${ARTISTS_TABLE} a
    WHERE ${NORMALIZE_FN}(a."artist_name") = ${NORMALIZE_FN}(${raw})
    LIMIT 2
  `);
  const strictRows = unwrapRows<IdRow>(strict);
  if (strictRows.length === 1) {
    return { kind: 'strict', artist_id: strictRows[0].artist_id };
  }
  if (strictRows.length > 1) {
    return { kind: 'ambiguous' };
  }

  // Restrict to synonym-class sources (BS#1383). The IN-list is built
  // at module load from SYNONYM_ALIAS_SOURCES — see the docstring on
  // that constant for the partition rationale and the BS#1390 drift
  // tracker.
  const alias: unknown = await db.execute(sql`
    SELECT DISTINCT asa."artist_id"
    FROM ${ARTIST_SEARCH_ALIAS_TABLE} asa
    WHERE ${NORMALIZE_FN}(asa."variant") = ${NORMALIZE_FN}(${raw})
      AND asa."source" IN (${SYNONYM_SOURCE_IN_LIST})
    LIMIT 2
  `);
  const aliasRows = unwrapRows<IdRow>(alias);
  if (aliasRows.length === 1) {
    return { kind: 'alias', artist_id: aliasRows[0].artist_id };
  }
  if (aliasRows.length > 1) {
    return { kind: 'ambiguous' };
  }

  return { kind: 'unmatched' };
};
