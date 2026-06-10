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

  // Restrict to synonym-class sources (BS#1383). The four
  // `artist_search_alias.source` values today partition into:
  //   - synonym-class: discogs_name_variation, discogs_alias,
  //     wxyc_library_alt — these name the same artist by another
  //     spelling, and folding them into the FK-write path is the
  //     substrate's whole point.
  //   - relational-class: discogs_member — this is "X was a member of
  //     Y", not "X is also called Y". Folding it in produced the
  //     Geordie Greep → black midi mislabel from the BS#1368 audit
  //     (Greep tours solo; WXYC only has his old band's records).
  // Positive allowlist is safe-by-default: a future LML source
  // (collaborator, featured-on, side-project) stays out of the FK-
  // write path until we explicitly opt it in here — the FK stays NULL
  // and the row drops to manual review, instead of silently writing a
  // wrong artist_id. The catalog-search sites take the opposite tack:
  // they DO want relational rows surfaced so iOS / dj-site can render
  // a "related artist" UX hint, and they propagate `source` end-to-end
  // for that reason. The resolver collapses to a single FK with no
  // wire-shape seam for `source`, so the partition is enforced here in
  // SQL.
  const alias: unknown = await db.execute(sql`
    SELECT DISTINCT asa."artist_id"
    FROM ${ARTIST_SEARCH_ALIAS_TABLE} asa
    WHERE ${NORMALIZE_FN}(asa."variant") = ${NORMALIZE_FN}(${raw})
      AND asa."source" IN ('discogs_name_variation', 'discogs_alias', 'wxyc_library_alt')
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
