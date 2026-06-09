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

type DistinctIdRow = { artist_id: number };

const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
};

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
  const strict: unknown = await db.execute(sql`
    SELECT DISTINCT a."id" AS artist_id
    FROM ${ARTISTS_TABLE} a
    WHERE ${NORMALIZE_FN}(a."artist_name") = ${NORMALIZE_FN}(${raw})
    LIMIT 2
  `);
  const strictRows = unwrapRows<DistinctIdRow>(strict);
  if (strictRows.length === 1) {
    return { kind: 'strict', artist_id: strictRows[0].artist_id };
  }
  if (strictRows.length > 1) {
    return { kind: 'ambiguous' };
  }

  const alias: unknown = await db.execute(sql`
    SELECT DISTINCT asa."artist_id"
    FROM ${ARTIST_SEARCH_ALIAS_TABLE} asa
    WHERE ${NORMALIZE_FN}(asa."variant") = ${NORMALIZE_FN}(${raw})
    LIMIT 2
  `);
  const aliasRows = unwrapRows<DistinctIdRow>(alias);
  if (aliasRows.length === 1) {
    return { kind: 'alias', artist_id: aliasRows[0].artist_id };
  }
  if (aliasRows.length > 1) {
    return { kind: 'ambiguous' };
  }

  return { kind: 'unmatched' };
};
