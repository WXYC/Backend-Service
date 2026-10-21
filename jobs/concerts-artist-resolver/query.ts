/**
 * Candidate query + resolver for jobs/concerts-artist-resolver (BS#1372).
 *
 * `loadCandidates` selects `concerts` rows that still need a canonical
 * artist FK: `headlining_artist_id IS NULL AND headlining_artist_raw IS
 * NOT NULL`. The `IS NULL` half is the idempotency gate — rerunning the
 * job picks up only still-unresolved rows; resolved rows are never
 * re-examined. Tribute-context rows (the word "tribute" in the title or
 * the raw name) are excluded outright: in a tribute-framed event the
 * billed name belongs to — or, worse, aliases — the HONOREE, not the
 * performer, so any match the arms could find is a mislabel by
 * construction (the Stanczyks "REM Tribute to Lifes Rich Pageant" row
 * alias-resolved to the real R.E.M.). The cost is that a genuinely
 * in-library tribute ACT stays unresolved — conservative under-resolution
 * over fabricated identity, same contract as the upstream extractor.
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
 * `artist_search_alias.source` partitions into three classes (BS#1383,
 * BS#3563). The resolver is the partition's owner: it decides which
 * sources are eligible to drive an FK write. Tests import these constants
 * directly so the SQL IN-lists and the test fixtures cannot drift.
 *
 *   - SYNONYM_ALIAS_SOURCES name the same artist by another spelling
 *     and are safe to fold into the FK-write path — that's the alias
 *     substrate's whole point.
 *   - VARIANT_GATED_ALIAS_SOURCES mix spelling variants with credits for
 *     other acts. A row drives an FK write only when it passes the
 *     variant gate (see below).
 *   - RELATIONAL_ALIAS_SOURCES express "X is related to Y" (member
 *     of, collaborator, etc.) and are NOT safe — they produce
 *     mislabels like the Geordie Greep → black midi case from the
 *     BS#1368 audit.
 *
 * Adding a new source (LML's or this repo's own) requires a deliberate choice here. The
 * resolver's SQL IN-lists are built from SYNONYM_ALIAS_SOURCES and
 * VARIANT_GATED_ALIAS_SOURCES, so a source the partition does not name is
 * silently excluded (safe-by-default: FK stays NULL, row drops to manual
 * review). The catalog-search sites do not consult these constants — they
 * propagate `source` to callers so iOS / dj-site can render relational
 * hits differently (e.g., "related artist") with full source context.
 *
 * Drift hazard (tracked by BS#1390): the `ArtistSearchAliasSource`
 * type union lives in three other places — lml-types.ts,
 * requestLine/types.ts, orchestrate.test.ts — none of which import
 * from each other or from these constants. BS#1390 consolidates them
 * around this partition; the matching SynonymAliasSource /
 * RelationalAliasSource types will be exported from here at that time.
 */
export const SYNONYM_ALIAS_SOURCES = ['discogs_name_variation', 'discogs_alias'] as const;

/**
 * `wxyc_library_alt` is the raw `library.alternate_artist_name`. The
 * station librarian uses that field both for spelling variants and for
 * member and collaborator credits (`Rhiannon Giddens` on Carolina
 * Chocolate Drops). On prod (BS#3563, 2026-10-21), no similarity
 * threshold separates the two kinds across the 3,969 rows.
 *
 * The variant gate: a gated row drives an FK write only when it is the
 * owner's own name spelled differently. That is, the variant and the
 * owner's `artist_name` are equal after lowercasing and dropping every
 * non-alphanumeric character (`Meshell Ndegeocello` on Me'Shell
 * Ndegeocello), or their normalized forms have trigram similarity 1, so
 * the same words in another order (`GZA/Genius` on Genius/GZA). On prod
 * the gate admits 47 rows beyond the ones strict already covers, and all
 * 47 are spelling variants. It rejects every credit, for example
 * Rhiannon Giddens → Carolina Chocolate Drops, Open Mike Eagle → Paul
 * White, and Adam Ant → Adam and the Ants. Typo-level variants
 * (`Spellling`) are left out.
 */
export const VARIANT_GATED_ALIAS_SOURCES = ['wxyc_library_alt'] as const;

// `wxyc_library_credit` (BS#3554) is one name from a comma-joined
// `library.alternate_artist_name` credit: a member or collaborator filed
// under the band's card, so it would make Rhiannon Giddens' concerts
// resolve to Carolina Chocolate Drops.
export const RELATIONAL_ALIAS_SOURCES = ['discogs_member', 'wxyc_library_credit'] as const;

/**
 * Frozen IN-lists for the alias arm, built once at module load. Safe-
 * by-construction: the partition is immutable and the values are
 * compile-time constants we control. The identifier-charset assumption
 * (`[A-Za-z0-9_]+`, Postgres' own convention) that lets us inline-
 * quote without escaping is pinned by the unit test
 * `inlined source values are identifier-safe` in
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
 * which is overkill for a short identifier-safe tuple.
 */
const toInList = (sources: readonly string[]) => sql.raw(sources.map((s) => `'${s}'`).join(', '));
const SYNONYM_SOURCE_IN_LIST = toInList(SYNONYM_ALIAS_SOURCES);
const VARIANT_GATED_SOURCE_IN_LIST = toInList(VARIANT_GATED_ALIAS_SOURCES);

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
      AND ("title" IS NULL OR "title" !~* '\\mtribute')
      AND "headlining_artist_raw" !~* '\\mtribute'
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

  // Synonym-class rows always count (BS#1383). Variant-gated rows count
  // only when they spell the owner's own name (BS#3563), so the arm joins
  // the owner's `artists` row. See the docstrings on the partition
  // constants for the rationale and the BS#1390 drift tracker.
  // `similarity` is pg_trgm's.
  const alias: unknown = await db.execute(sql`
    SELECT DISTINCT asa."artist_id"
    FROM ${ARTIST_SEARCH_ALIAS_TABLE} asa
    JOIN ${ARTISTS_TABLE} owner ON owner."id" = asa."artist_id"
    WHERE ${NORMALIZE_FN}(asa."variant") = ${NORMALIZE_FN}(${raw})
      AND (
        asa."source" IN (${SYNONYM_SOURCE_IN_LIST})
        OR (
          asa."source" IN (${VARIANT_GATED_SOURCE_IN_LIST})
          AND (
            regexp_replace(lower(asa."variant"), '[^[:alnum:]]', '', 'g')
              = regexp_replace(lower(owner."artist_name"), '[^[:alnum:]]', '', 'g')
            OR similarity(${NORMALIZE_FN}(asa."variant"), ${NORMALIZE_FN}(owner."artist_name")) = 1
          )
        )
      )
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
