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

  test.each([
    ['no filter', () => listReviews({}, ACTOR)],
    ['album_id', () => listReviews({ album_id: 9 }, ACTOR)],
    ['intake_item_id', () => listReviews({ intake_item_id: 7 }, ACTOR)],
    ['mine', () => listReviews({ mine: true }, ACTOR)],
    ['every filter', () => listReviews({ album_id: 9, intake_item_id: 7, mine: true }, ACTOR)],
    ['the by-id read', () => getReview(3, ACTOR)],
  ])('%s applies the read rule to drafts, as one statement', async (_n, read) => {
    await read();
    expect(mockCaptured).toHaveLength(1);
    expect(last()).toContain(`"status" <> 'draft' OR`);
    expect(mockCaptured[0].params).toContain('caller-id');
  });

  test('the album list sorts by the same select alias that carries on_cover, computed once', async () => {
    await listReviews({ album_id: 9 }, ACTOR);
    expect(mockCaptured).toHaveLength(1);
    const text = last();
    expect(text).toContain('order by on_cover desc, coalesce(');
    // The on_cover field alone: it starts at the accepting-item EXISTS scoped to the release (`ai.album_id`), which
    // in_use's own accepting-item EXISTS (`AND true`) cannot match, and ends at the alias.
    const field = text.match(
      /(\(EXISTS \(SELECT 1 FROM "wxyc_schema"\."intake_items" AS ai WHERE ai\.accepted_review_id = [^)]*?AND ai\.album_id = .*?) as "on_cover"/s
    );
    expect(field).not.toBeNull();
    const onCover = field[1];
    expect(onCover).not.toContain('AND true');
    // The expression is written in the select only; the ORDER BY names its alias.
    expect(text.split(onCover).length - 1).toBe(1);
    // Both of the cover's halves are in the expression: accepted for a copy of this release, or its latest print.
    expect(onCover).toContain('ai.accepted_review_id');
    expect(onCover).toContain('ai.state IN');
    expect(onCover).toContain('review_prints');
    expect(onCover).toContain('"p"."album_id" =');
  });

  test('in_use is the accepting-item EXISTS or the exported print fragment, rendered identically', async () => {
    await getReview(3, ACTOR);
    const dialect = new PgDialect();
    const fragment = flat(dialect.sqlToQuery(sql`${latestPrintOfCopy(sql`${reviews.id}`)}`).sql);
    expect(last()).toContain(fragment);
    expect(last()).toContain('ai.accepted_review_id');
  });
});
