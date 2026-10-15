/**
 * Pins why `outerRef` exists: a single-table select renders a bare outer column unqualified, which a correlated
 * subquery would bind to its own table. `.toSQL()` never executes; the REAL schema comes from an explicit factory,
 * the mechanism `intake.service.sql.test.ts` documents.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  return { ...realSchema, db: drizzle({}) };
});

import { notExists, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, reviews, review_revisions, rotation } from '@wxyc/database';
import { displayedArtistName, outerRef, rotationSuccessorSql } from '../../../apps/backend/utils/sql-fragments';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const revisionCount = (outer: unknown) =>
  sql<number>`(SELECT count(*)::int FROM ${review_revisions} WHERE ${review_revisions.review_id} = ${outer})`;

describe('outerRef', () => {
  it('keeps the outer column table-qualified in a single-table select', () => {
    const { sql: rendered } = db
      .select({ n: revisionCount(outerRef(reviews.id)) })
      .from(reviews)
      .toSQL();
    expect(rendered).toContain(`= "${SCHEMA}"."reviews"."id")`);
  });

  it('documents the trap: the bare column renders unqualified', () => {
    const { sql: rendered } = db
      .select({ n: revisionCount(reviews.id) })
      .from(reviews)
      .toSQL();
    expect(rendered).toContain('= "id")');
  });
});

describe('rotationSuccessorSql (BS#3007)', () => {
  it('correlates a successor row naming the outer rotation row in moved_from_rotation_id, spelled out literally', () => {
    const { sql: rendered } = db
      .select({ id: rotation.id })
      .from(rotation)
      .where(notExists(rotationSuccessorSql()))
      .toSQL();
    // Direction matters: `successor.moved_from_rotation_id = <outer>.id` means the outer row was moved away. Reversed
    // (`successor.id = <outer>.moved_from_rotation_id`) it would hide every chain's newest row and queue the rest.
    expect(rendered).toContain(
      `not exists (SELECT 1 FROM "${SCHEMA}"."rotation" AS successor ` +
        `WHERE successor.moved_from_rotation_id = "${SCHEMA}"."rotation"."id")`
    );
  });
});

describe('displayedArtistName (BS#3284, BS#3286)', () => {
  it('is the trimmed alternate artist name, prefixed `V/A ` on a compilation, unless blank, else the filed artist, spelled out literally', () => {
    const { sql: rendered } = new PgDialect().sqlToQuery(displayedArtistName);
    // `trim` is what makes a whitespace-only alternate name count as blank: `nullif(x, '')` alone keeps `'  '`. The
    // prefix is concatenated onto the nullif, so a blank alternate name stays NULL and falls through to the filed artist.
    expect(rendered).toBe(
      `coalesce(CASE WHEN (upper(trim("${SCHEMA}"."artists"."code_letters")) = 'V/A' OR trim("${SCHEMA}"."artists"."code_letters") LIKE 'Z-%') THEN 'V/A ' ELSE '' END || nullif(trim("${SCHEMA}"."library"."alternate_artist_name"), ''), "${SCHEMA}"."artists"."artist_name")`
    );
  });
});
