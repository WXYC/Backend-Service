/**
 * `GET /reviews` reads (BS#2805): the rendered SQL of each list. The semantics (visibility, citation, on_cover, in_use,
 * print fields) run against real Postgres in tests/integration/reviews-read.spec.js; this file pins what a scripted
 * database cannot see: every list is ONE statement, the album list's order and its `on_cover` field come from one
 * expression, and `in_use` is the shared print fragment.
 */
jest.unmock('drizzle-orm');

const mockCaptured: { sql: string; params: unknown[] }[] = [];

jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.roles'));
jest.mock('@wxyc/database', () => {
  const schema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const real = drizzle.mock({ schema });
  return {
    ...schema,
    db: {
      select: (fields: unknown) => {
        const builder = real.select(fields);
        const from = builder.from.bind(builder);
        builder.from = (table: unknown) => {
          const query = from(table);
          // Awaiting the query records the statement instead of running it.
          query.then = (resolve: (rows: unknown[]) => unknown) => {
            mockCaptured.push(query.toSQL());
            return Promise.resolve(resolve([]));
          };
          return query;
        };
        return builder;
      },
    },
  };
});

import { getReview, latestPrintOfCopy, listReviews } from '../../../apps/backend/services/reviews.service';
import { sql } from 'drizzle-orm';
import { reviews } from '../../../shared/database/src/schema';
import { PgDialect } from 'drizzle-orm/pg-core';

const ACTOR = { id: 'caller-id', manage: false };
const flat = (text: string) => text.replace(/\s+/g, ' ');
const last = () => flat(mockCaptured[mockCaptured.length - 1].sql);

beforeEach(() => {
  mockCaptured.length = 0;
});

describe('review reads (BS#2805)', () => {
  test.each([
    ['no filter', {}],
    ['intake_item_id', { intake_item_id: 7 }],
    ['mine', { mine: true }],
  ])('the %s list is one statement, newest first, with on_cover constant false and no in-use group', async (_n, f) => {
    await listReviews(f, ACTOR);
    expect(mockCaptured).toHaveLength(1);
    expect(last()).toContain('false as "on_cover"');
    expect(last()).toContain(
      'order by coalesce("wxyc_schema"."reviews"."submitted_at", "wxyc_schema"."reviews"."last_modified") desc, "wxyc_schema"."reviews"."id" desc'
    );
    expect(last()).not.toContain('order by on_cover');
  });

  test('every list and the by-id read apply the read rule to drafts', async () => {
    await listReviews({}, ACTOR);
    await getReview(3, ACTOR);
    for (const { sql: text } of mockCaptured) {
      expect(flat(text)).toContain(`"status" <> 'draft' OR`);
    }
    expect(mockCaptured.every((q) => q.params.includes('caller-id'))).toBe(true);
  });

  test('the album list sorts by the same select alias that carries on_cover, computed once', async () => {
    await listReviews({ album_id: 9 }, ACTOR);
    expect(mockCaptured).toHaveLength(1);
    const text = last();
    expect(text).toContain('order by on_cover desc, coalesce(');
    const field = text.match(/\((EXISTS \(SELECT 1 FROM .*?\)\)) as "on_cover"/s);
    expect(field).not.toBeNull();
    // The expression is written in the select only; the ORDER BY names its alias.
    expect(text.split(field[1]).length - 1).toBe(1);
    // Both of the cover's halves are in the expression.
    expect(field[1]).toContain('ai.accepted_review_id');
    expect(field[1]).toContain('review_prints');
  });

  test('in_use is the accepting-item EXISTS or the exported print fragment, rendered identically', async () => {
    await getReview(3, ACTOR);
    const dialect = new PgDialect();
    const fragment = flat(dialect.sqlToQuery(sql`${latestPrintOfCopy(sql`${reviews.id}`)}`).sql);
    expect(last()).toContain(fragment);
    expect(last()).toContain('ai.accepted_review_id');
  });
});
