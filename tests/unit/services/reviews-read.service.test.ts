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
  return jest.requireActual('../../utils/real-database-module').realDatabaseModule({
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
  });
});

import {
  getReview,
  latestPrintOfCopy,
  listReviewRevisions,
  listReviews,
} from '../../../apps/backend/services/reviews.service';
import { FILED_STATES } from '../../../apps/backend/services/intake.service';
import fs from 'fs';
import path from 'path';
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

  // BS#3075: one fragment decides in_use, on_cover, deleteReview and printedCopies, so the supersession lives in it and nowhere else.
  test('latestPrintOfCopy lets a print with no item count only while its release does not have exactly one filed or finalized copy', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(sql`${latestPrintOfCopy(sql`${reviews.id}`)}`);
    expect(flat(text)).toContain(
      'AND ("p"."intake_item_id" IS NOT NULL OR (SELECT count(*) FROM "wxyc_schema"."intake_items" AS oc WHERE oc.album_id = "p"."album_id" AND oc.state IN ($1, $2)) <> 1) AND NOT EXISTS'
    );
    expect(params).toEqual(FILED_STATES);
  });

  // `in_use` is built when reviews.service loads, so the stubbed set is installed before the module under test is required.
  test('every filed-state fragment follows FILED_STATES', async () => {
    let isolated!: typeof import('../../../apps/backend/services/reviews.service');
    await jest.isolateModulesAsync(async () => {
      const intake = await import('../../../apps/backend/services/intake.service');
      intake.FILED_STATES.splice(0, intake.FILED_STATES.length, 'reviewed', 'pool', 'checked_out');
      isolated = await import('../../../apps/backend/services/reviews.service');
    });
    const dialect = new PgDialect();
    const print = dialect.sqlToQuery(sql`${isolated.latestPrintOfCopy(sql`${reviews.id}`)}`);
    expect(print.sql).toContain('oc.state IN ($1, $2, $3)');
    expect(print.params).toEqual(['reviewed', 'pool', 'checked_out']);
    expect(dialect.sqlToQuery(sql`${isolated.reviewInReleaseList(9)}`).params).toEqual([
      9,
      9,
      'reviewed',
      'pool',
      'checked_out',
    ]);
    mockCaptured.length = 0;
    await isolated.listReviews({ album_id: 9 }, ACTOR);
    const { sql: text, params } = mockCaptured[0];
    // in_use's print, on_cover's accepted half, releaseCopies, on_cover's print (the count), and the membership rule.
    expect(text.match(/\.state IN \(\$\d+, \$\d+, \$\d+\)/g)).toHaveLength(5);
    expect(params.filter((v) => v === 'reviewed')).toHaveLength(5);
    expect(params.filter((v) => v === 'filed' || v === 'finalized')).toHaveLength(0);
  });

  test('no filed/finalized literal is spelled in the services outside the FILED_STATES declaration', () => {
    const dir = path.join(__dirname, '../../../apps/backend/services');
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(dir, f), 'utf8')
          .split('\n')
          .filter((line) => /'filed',\s*'finalized'/.test(line) && !line.includes('export const FILED_STATES'))
          .map((line) => `${f}: ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });

  test('the album list reaches that rule through the same fragment for on_cover, and in_use through it too', async () => {
    await listReviews({ album_id: 9 }, ACTOR);
    const rule = '(SELECT count(*) FROM "wxyc_schema"."intake_items" AS oc WHERE oc.album_id = "p"."album_id"';
    // in_use and the album list's on_cover half: two renderings of the one fragment.
    expect(last().split(rule).length - 1).toBe(2);
  });

  test.each([
    ['getReview', () => getReview(3, ACTOR)],
    ['the plain list', () => listReviews({}, ACTOR)],
    ['the album list', () => listReviews({ album_id: 9 }, ACTOR)],
  ])('%s counts review_revisions through the outer review, never a bare id (BS#2861)', async (_n, run) => {
    await run();
    expect(last()).toContain(
      '(SELECT count(*)::int FROM "wxyc_schema"."review_revisions" AS rr WHERE rr.review_id = "wxyc_schema"."reviews"."id")'
    );
  });

  test.each([
    ['getReview', () => getReview(3, ACTOR)],
    ['the plain list', () => listReviews({}, ACTOR)],
    ['the album list', () => listReviews({ album_id: 9 }, ACTOR)],
  ])('%s correlates the latest print through the outer review, never a bare id', async (_n, run) => {
    await run();
    // One subquery each for printed_revision_id and printed_at.
    expect(last().split('lp.review_id = "wxyc_schema"."reviews"."id"').length - 1).toBe(2);
  });

  test('the revision read checks the review visibility rule first and answers undefined when nothing is visible (BS#2861)', async () => {
    expect(await listReviewRevisions(3, ACTOR)).toBeUndefined();
    expect(mockCaptured).toHaveLength(1);
    expect(last()).toContain('"wxyc_schema"."reviews"."status" <> \'draft\'');
    expect(last()).toContain('"wxyc_schema"."reviews"."author_user_id" = $');
  });
});
