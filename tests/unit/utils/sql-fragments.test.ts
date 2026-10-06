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

import { sql } from 'drizzle-orm';
import { db, reviews, review_revisions } from '@wxyc/database';
import { outerRef } from '../../../apps/backend/utils/sql-fragments';

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
