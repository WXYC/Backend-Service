/**
 * Genuinely-rendered-SQL pins for the `/intake` reads (BS#2796).
 *
 * Effective state is the one definition the list filter, the lanes and (from
 * slice 8) every transition's precondition share, so what these pin is its
 * shape: a stale `requested` row reads as `pool` after 7 days or when the
 * requested DJ's account is gone, and a row whose checkout is more than 14 days
 * old is overdue, whatever its state. The real-Postgres behavior (a stale row listed as `pool` and left
 * untouched) is pinned by `tests/integration/intake-items.spec.js`.
 *
 * `jest.unit.config.ts` redirects `@wxyc/database` to a stub whose tables are
 * plain strings, so an explicit factory supplies the REAL schema plus a
 * never-connected drizzle instance — the mechanism
 * `flowsheet.getOpenShows.sql.test.ts` documents. `.toSQL()` never executes.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  const nyTime = jest.requireActual('../../../shared/database/src/ny-time');
  return { ...realSchema, ...nyTime, db: drizzle({}) };
});

jest.mock('../../../apps/backend/utils/review-gate-cutover', () => {
  const actual = jest.requireActual('../../../apps/backend/utils/review-gate-cutover');
  return { ...actual, reviewGateCutoverDate: jest.fn(actual.reviewGateCutoverDate) };
});

import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, intake_items } from '@wxyc/database';
import { reviewGateCutoverDate } from '../../../apps/backend/utils/review-gate-cutover';
import {
  updateIntakeItem,
  buildIntakePatch,
  buildIntakeSelect,
  buildTransition,
  deleteIntakeItem,
  RELEASE_ACCEPTED_REVIEW,
  refusalOutcome,
  reviewAuthorsSql,
  acceptReview,
} from '../../../apps/backend/services/intake.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const render = (opts: Parameters<typeof buildIntakeSelect>[0]) => buildIntakeSelect(opts).toSQL();

describe('buildIntakeSelect — effective state (BS#2796)', () => {
  const { sql: rendered } = render({ includePasses: false });
  const text = rendered.toLowerCase();

  it('reads a requested row as pool once the request is more than 7 days old', () => {
    expect(text).toContain(`"${SCHEMA}"."intake_items"."requested_at" < now() - interval '7 days'`);
  });

  it('reads a requested row as pool when the requested DJ account is gone (requested_dj_id NULL)', () => {
    expect(text).toContain(`"${SCHEMA}"."intake_items"."requested_dj_id" is null`);
  });

  it('only ever rewrites a requested row — every other state passes through', () => {
    expect(text).toMatch(/case when "[^"]+"\."intake_items"\."state" = 'requested' and/);
    expect(text).toMatch(/then 'pool' else "[^"]+"\."intake_items"\."state"::text end/);
  });

  // Without the parentheses AND binds tighter than OR, and any row whose
  // requested_at is old — a checked_out item, say — would read as pool.
  it('groups the two expiry arms so state = requested governs both', () => {
    const t = `"${SCHEMA}"."intake_items"`;
    expect(text).toContain(
      `${t}."state" = 'requested' and (${t}."requested_dj_id" is null or ${t}."requested_at" is null or ${t}."requested_at" < now() - interval '7 days') then 'pool'`
    );
  });

  // `requested_at < …` is NULL, not true, when requested_at is NULL; without this arm the CASE falls through and the row reads `requested` forever.
  it('reads a requested row with a NULL requested_at as pool', () => {
    expect(text).toContain(`"${SCHEMA}"."intake_items"."requested_at" is null or`);
  });

  it('flags overdue on any row whose checkout is older than 14 days, with no state test (decision 39)', () => {
    const t = `"${SCHEMA}"."intake_items"`;
    const overdue = text.slice(text.indexOf('coalesce('), text.indexOf('as "overdue"'));
    expect(overdue).toContain(`${t}."checked_out_at" < now() - interval '14 days'`);
    expect(overdue).not.toContain('"state"');
  });

  it('makes overdue false, never NULL, for a row with no checked_out_at', () => {
    const t = `"${SCHEMA}"."intake_items"`;
    expect(text).toContain(`coalesce(${t}."checked_out_at" < now() - interval '14 days', false) as "overdue"`);
  });

  it('is a SELECT — reading never writes', () => {
    expect(text.trimStart()).toMatch(/^select /);
  });
});

describe('buildIntakeSelect — filter and order', () => {
  it('filters on the effective-state expression, binding the validated state as a parameter', () => {
    const { sql: text, params } = render({ state: 'pool', includePasses: false });
    expect(text).toMatch(/where \(case when .* end\) = \$1/is);
    expect(params).toEqual(['pool']);
  });

  it('orders by logged_at DESC, id DESC so equal timestamps are stable', () => {
    const { sql: text } = render({ includePasses: false });
    expect(text).toContain(
      `order by "${SCHEMA}"."intake_items"."logged_at" desc, "${SCHEMA}"."intake_items"."id" desc`
    );
  });

  it('names DJs from auth_user.name and never reads real_name', () => {
    const { sql: text } = render({ includePasses: true });
    expect(text).not.toContain('real_name');
    expect(text).toContain('"name"');
  });
});

describe('buildIntakeSelect — passes', () => {
  it('omits passes entirely when the caller lacks reviews:manage', () => {
    expect(render({ includePasses: false }).sql).not.toContain('intake_item_passes');
  });

  it('loads passes for every item inside the same statement, not one query per item', () => {
    const { sql: rendered } = render({ includePasses: true });
    const text = rendered.toLowerCase();
    expect(text).toContain(`from "${SCHEMA}"."intake_item_passes"`);
    expect(text).toContain('json_agg');
    expect(text).toContain(`"${SCHEMA}"."intake_item_passes"."intake_item_id" = "${SCHEMA}"."intake_items"."id"`);
  });
});

describe('buildIntakeSelect — accepted-review columns and review fields (BS#2858, BS#2860)', () => {
  const T = `"${SCHEMA}"`;

  it('exposes accepted_review_id, accepted_by and accepted_at', () => {
    for (const includePasses of [false, true]) {
      const { sql: text } = render({ includePasses });
      for (const column of ['accepted_review_id', 'accepted_by', 'accepted_at']) {
        expect(text).toContain(`${T}."intake_items"."${column}"`);
      }
    }
  });

  it('counts submitted reviews in a correlated subquery of the same statement, for every caller', () => {
    for (const includePasses of [false, true]) {
      const text = render({ includePasses }).sql;
      expect(text).toContain(
        `(SELECT count(*)::int FROM ${T}."reviews" WHERE ${T}."reviews"."intake_item_id" = ${T}."intake_items"."id" AND ${T}."reviews"."status" = 'submitted') as "submitted_review_count"`
      );
    }
  });

  it('selects draft_authors as a correlated subquery of the same statement for reviews:manage, and never otherwise', () => {
    const text = render({ includePasses: true }).sql;
    expect(text).toContain(
      `${T}."reviews"."intake_item_id" = ${T}."intake_items"."id" AND ${T}."reviews"."status" = 'draft'`
    );
    expect(text).toContain('as "draft_authors"');
    expect(render({ includePasses: false }).sql).not.toContain('draft_authors');
  });

  it('draft_authors carries names only: no review text, no review id in the output', () => {
    const text = render({ includePasses: true }).sql;
    const sub = text.slice(text.indexOf('json_agg(', text.indexOf('as "passes"')), text.indexOf('as "draft_authors"'));
    expect(sub).not.toMatch(/"review"\b|"artist_blurb"|"buzzwords"/);
  });

  it('awaiting_acceptance keeps items with a submitted review, no accepted one and no filing, ANDed with state', () => {
    const { sql: text, params } = render({ includePasses: false, awaitingAcceptance: true, state: 'pool' });
    expect(text).toContain(`${T}."reviews"."status" = 'submitted') > 0`);
    expect(text).toContain(`${T}."intake_items"."accepted_review_id" IS NULL`);
    expect(text).toMatch(/"state" not in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['pool', 'filed', 'finalized']));
    expect(render({ includePasses: false, awaitingAcceptance: false }).sql).not.toContain(
      'accepted_review_id" IS NULL'
    );
  });
});

describe('reviewAuthorsSql (BS#2860) — the one list behind draft_authors and deleted_review_authors', () => {
  const render = (draftsOnly?: boolean) =>
    new PgDialect().sqlToQuery(sql`SELECT ${reviewAuthorsSql(draftsOnly)} FROM ${intake_items}`).sql;
  const T = `"${SCHEMA}"`;

  it('names the author of each review on the item, oldest first, leaving out a review with no author text', () => {
    const text = render();
    expect(text).toContain(
      `json_agg(${T}."reviews"."author" ORDER BY ${T}."reviews"."id") FILTER (WHERE ${T}."reviews"."author" IS NOT NULL)`
    );
    expect(text).toContain(`coalesce(`);
    expect(text).toContain(`'[]'::json`);
    expect(text).toContain(`WHERE ${T}."reviews"."intake_item_id" = ${T}."intake_items"."id")`);
    expect(text).not.toContain('"status"');
  });

  it('with draftsOnly restricts the subquery to unsubmitted drafts', () => {
    expect(render(true)).toContain(`AND ${T}."reviews"."status" = 'draft')`);
  });
});

describe('buildTransition (BS#2798)', () => {
  const t = `"${SCHEMA}"."intake_items"`;
  const dj = { id: 'dj-1', manage: false };
  const md = { id: 'md-1', manage: true };
  const render = (...args: Parameters<typeof buildTransition>) => {
    const q = buildTransition(...args).toSQL();
    return { text: q.sql.toLowerCase(), params: q.params };
  };

  it.each([
    ['checkout', ['pool']],
    ['release', ['checked_out', 'reviewed']],
    ['request', ['pool']],
    ['cancel_request', ['requested']],
    ['accept', ['requested']],
    ['pass', ['requested']],
  ] as const)('%s is one UPDATE whose WHERE carries the id and the effective-state precondition %s', (action, from) => {
    const { text, params } = render(action, 7, md, 'dj-2');
    expect(text.trimStart()).toMatch(/^update /);
    expect(text).toMatch(/where \(.*"id" = \$\d+ and \(case when .* end\) in \(\$\d+(, \$\d+)*\)/s);
    expect(text).toContain('returning');
    expect(params).toEqual(expect.arrayContaining([7, ...from]));
  });

  it('checkout stamps the holder and clears any stale request fields', () => {
    const { text, params } = render('checkout', 7, dj);
    expect(text).toMatch(
      /set "state" = \$\d+, "requested_dj_id" = \$\d+, "requested_at" = \$\d+, "checked_out_by" = \$\d+, "checked_out_at" = now\(\)/
    );
    expect(params).toEqual(expect.arrayContaining(['checked_out', null, 'dj-1']));
  });

  it('release clears the holder fields and falls to pool only from checked_out, so a reviewed item stays reviewed', () => {
    const { text, params } = render('release', 7, md);
    expect(text).toMatch(
      new RegExp(
        `set "state" = case when ${t}."state" = 'checked_out' then 'pool' else ${t}."state" end, "checked_out_by" = \\$\\d+, "checked_out_at" = \\$\\d+`
      )
    );
    expect(params.slice(0, 2)).toEqual([null, null]);
    expect(text).not.toContain('accepted_');
  });

  it('release from reviewed also requires a checkout: checked_out_at IS NOT NULL on the reviewed arm, for every caller', () => {
    for (const actor of [dj, md]) {
      const { text } = render('release', 7, actor);
      expect(text).toContain(`(${t}."state" <> 'reviewed' or ${t}."checked_out_at" is not null)`);
    }
  });

  it('release by a caller without reviews:manage requires checked_out_by = caller in the WHERE', () => {
    const { text, params } = render('release', 7, dj);
    expect(text).toContain(`${t}."checked_out_by" = $`);
    expect(params).toContain('dj-1');
  });

  it('release by reviews:manage lifts the holder condition', () => {
    const { text } = render('release', 7, md);
    expect(text.slice(text.indexOf(' where '))).not.toContain('"checked_out_by" =');
  });

  it.each(['accept', 'pass'] as const)(
    '%s requires requested_dj_id = caller in the WHERE, even for a manager',
    (action) => {
      const { text, params } = render(action, 7, md);
      expect(text).toContain(`${t}."requested_dj_id" = $`);
      expect(params).toContain('md-1');
    }
  );

  it('accept clears the request fields and stamps the holder', () => {
    const { text, params } = render('accept', 7, dj);
    expect(text).toContain('"requested_dj_id" = $');
    expect(text).toContain('"checked_out_at" = now()');
    expect(params).toEqual(expect.arrayContaining(['checked_out', null, 'dj-1']));
  });

  it('request stamps the target DJ and requested_at', () => {
    const { text, params } = render('request', 7, md, 'dj-2');
    expect(text).toContain('"requested_at" = now()');
    expect(params).toEqual(expect.arrayContaining(['requested', 'dj-2']));
  });

  it('cancel_request and pass clear the request fields and return the item to pool', () => {
    for (const action of ['cancel_request', 'pass'] as const) {
      const { params } = render(action, 7, action === 'pass' ? dj : md);
      expect(params.slice(0, 3)).toEqual(['pool', null, null]);
    }
  });
});

// The route answers a missing grant 403 before the service runs; once it does, a 409 outranks the identity 403 (BS#2798).
describe('refusalOutcome — 409 state_changed ranks before the identity 403', () => {
  it.each([
    ['a missing item', undefined, { from: 'pool', identityGuarded: true }, 'not_found'],
    ['no transition (patch/delete) on a surviving item', { effective_state: 'filed' }, undefined, 'already_filed'],
    ['a citation patch on a missing item', undefined, 'citation', 'not_found'],
    ['a citation patch on a filed item', { effective_state: 'filed' }, 'citation', 'already_filed'],
    ['a citation patch on a finalized item', { effective_state: 'finalized' }, 'citation', 'already_filed'],
    ['a citation patch on an unfiled item', { effective_state: 'pool' }, 'citation', 'invalid_citation'],
    [
      'an identity-guarded refusal on an item still in the from state',
      { effective_state: 'checked_out' },
      { from: ['checked_out'], identityGuarded: true },
      'forbidden',
    ],
    [
      'an identity-guarded transition on an item in another state',
      { effective_state: 'pool' },
      { from: ['checked_out'], identityGuarded: true },
      'state_changed',
    ],
    [
      'an identity-guarded transition on a filed item',
      { effective_state: 'filed' },
      { from: ['requested'], identityGuarded: true },
      'state_changed',
    ],
    [
      'an unguarded transition on an item in the from state',
      { effective_state: 'pool' },
      { from: ['pool'], identityGuarded: false },
      'state_changed',
    ],
    [
      'an identity-guarded refusal on a reviewed item that still has a checkout',
      { effective_state: 'reviewed', checked_out_at: new Date() },
      { from: ['checked_out', 'reviewed'], identityGuarded: true },
      'forbidden',
    ],
    [
      'an identity-guarded release of a reviewed item with no checkout: state_changed, not forbidden',
      { effective_state: 'reviewed', checked_out_at: null },
      { from: ['checked_out', 'reviewed'], identityGuarded: true },
      'state_changed',
    ],
    [
      'an unguarded release of a reviewed item with no checkout',
      { effective_state: 'reviewed', checked_out_at: null },
      { from: ['checked_out', 'reviewed'], identityGuarded: false },
      'state_changed',
    ],
  ] as const)('%s', (_name, item, transition, expected) => {
    expect(refusalOutcome(item as never, transition as never)).toBe(expected);
  });
});

describe('buildIntakePatch — citations (BS#2797)', () => {
  const T = `"${SCHEMA}"`;
  const render = (patch: Parameters<typeof buildIntakePatch>[1], cutover?: string) => {
    if (cutover === undefined) delete process.env.REVIEW_GATE_CUTOVER_DATE;
    else process.env.REVIEW_GATE_CUTOVER_DATE = cutover;
    return buildIntakePatch(7, patch).toSQL();
  };
  afterEach(() => delete process.env.REVIEW_GATE_CUTOVER_DATE);

  it('puts validity in the same UPDATE: a submitted review or a station-date add_date on or before the cutover', () => {
    const { sql: text, params } = render({ cited_album_id: 5 }, '2027-01-12');
    expect(text).toContain(`${T}."intake_items"."state" not in (`);
    expect(text).toContain(`${T}."reviews"."status" = 'submitted') OR EXISTS (`);
    expect(text).toContain(`(${T}."library"."add_date" AT TIME ZONE 'America/New_York')::date <= $`);
    expect(params).toContain('2027-01-12');
  });

  it('admits any existing release while the cutover is unset', () => {
    const { sql: text } = render({ cited_album_id: 5 });
    expect(text).toContain(`${T}."library"."id" = $`);
    expect(text).not.toContain('AT TIME ZONE');
  });

  it('checks a submission against its station date', () => {
    const { sql: text } = render({ cited_submission_id: 12 }, '2027-01-12');
    expect(text).toContain(`(${T}."album_review_submissions"."submitted_at" AT TIME ZONE 'America/New_York')::date`);
    expect(text).not.toContain('"reviews"."status"');
  });

  it.each([
    ['a release clears the submission', { cited_album_id: 5 }, 'cited_submission_id'],
    ['a submission clears the release', { cited_submission_id: 12 }, 'cited_album_id'],
  ])('setting %s in the same statement', (_name, patch, cleared) => {
    const { sql: text } = render(patch, '2027-01-12');
    expect(text).toContain(`"${cleared}" = $`);
  });

  it('adds no citation validity predicate, and clears no submission, for a patch that sets none', () => {
    const { sql: text } = render({ album_title: 'DOGA', cited_album_id: null });
    expect(text).not.toContain('"library"');
    expect(text).not.toContain('album_review_submissions');
    expect(text).not.toContain('"cited_submission_id"');
  });

  it.each([
    ['a title-only patch', { album_title: 'DOGA' }],
    ['a clear-only patch', { cited_album_id: null }],
    ['a clear of both citations', { cited_album_id: null, cited_submission_id: null }],
  ])('never reads the cutover date for %s', (_name, patch) => {
    (reviewGateCutoverDate as jest.Mock).mockClear();
    buildIntakePatch(7, patch);
    expect(reviewGateCutoverDate).not.toHaveBeenCalled();
  });

  it('reads the cutover date when a patch sets a citation', () => {
    (reviewGateCutoverDate as jest.Mock).mockClear();
    buildIntakePatch(7, { cited_submission_id: 12 });
    expect(reviewGateCutoverDate).toHaveBeenCalled();
  });
});

describe('buildIntakePatch — a citation change takes off a review chosen through it (BS#2860)', () => {
  const T = `"${SCHEMA}"."intake_items"`;
  const render = (patch: Parameters<typeof buildIntakePatch>[1]) => {
    delete process.env.REVIEW_GATE_CUTOVER_DATE;
    const q = buildIntakePatch(7, patch).toSQL();
    return { text: q.sql, params: q.params };
  };
  const NOT_OWN = `exists (select 1 from "${SCHEMA}"."reviews" where "${SCHEMA}"."reviews"."id" = ${T}."accepted_review_id" and "${SCHEMA}"."reviews"."intake_item_id" is distinct from ${T}."id")`;

  it.each([
    ['a different release', { cited_album_id: 5 }, `${T}."cited_album_id" is distinct from $`],
    ['a clear to null', { cited_album_id: null }, `${T}."cited_album_id" is not null and`],
    [
      'the submission switch (cited_submission_id clears cited_album_id)',
      { cited_submission_id: 12 },
      `${T}."cited_album_id" is not null and`,
    ],
  ])(
    '%s compares the stored cited_album_id with the value the patch leaves, and clears the three accept columns and the state in the same UPDATE',
    (_name, patch, change) => {
      const text = render(patch).text.toLowerCase();
      expect(text).toContain(`${change.replace(' and', '')}`.toLowerCase());
      expect(text).toContain(NOT_OWN);
      for (const column of ['accepted_review_id', 'accepted_by', 'accepted_at']) {
        expect(text).toMatch(new RegExp(`"${column}" = case when .* then null else ${T}\\."${column}" end`, 's'));
      }
      expect(text).toMatch(
        /"state" = case when .* then case when .*'reviewed' and .*"checked_out_at" is not null then 'checked_out'/s
      );
    }
  );

  it.each([
    ['a title-only patch', { album_title: 'DOGA' }],
    ['a submission clear that carries no citation', { cited_submission_id: null }],
  ])('%s leaves the accepted review alone', (_name, patch) => {
    expect(render(patch).text).not.toContain('accepted_review_id');
  });

  it('leaves the checkout alone: a removed holder returns to checked_out with checked_out_at unchanged', () => {
    expect(render({ cited_album_id: null }).text.toLowerCase()).not.toMatch(/"checked_out_(at|by)" = /);
  });

  it('never reads the review row under a lock: the test is a plain EXISTS', () => {
    expect(render({ cited_album_id: null }).text.toLowerCase()).not.toContain('for update');
  });
});

describe('the service refuses both citations non-null (BS#2797)', () => {
  it('buildIntakePatch throws a 400 and writes nothing', () => {
    expect(() => buildIntakePatch(7, { cited_album_id: 5, cited_submission_id: 12 })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('updateIntakeItem rejects with the same 400 instead of reporting updated', async () => {
    const update = jest.spyOn(db, 'update');
    await expect(updateIntakeItem(7, { cited_album_id: 5, cited_submission_id: 12 })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(update).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe('updateIntakeItem — refusal order end to end (BS#2797)', () => {
  /** A chainable, awaitable stand-in for a drizzle builder that resolves to `rows`. */
  const builder = (rows: unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve(rows) : () => proxy),
    });
    return proxy;
  };

  const refuse = async (patch: Parameters<typeof updateIntakeItem>[1], effective_state: string) => {
    jest.spyOn(db, 'update').mockReturnValue(builder([]) as never); // the guarded UPDATE touched no row
    jest.spyOn(db, 'select').mockReturnValue(builder([{ id: 7, effective_state }]) as never);
    return (await updateIntakeItem(7, patch)).outcome;
  };

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'an invalid citation on an unfiled item is invalid_citation, not already_filed',
      { cited_album_id: 5 },
      'pool',
      'invalid_citation',
    ],
    [
      'an invalid submission citation on an unfiled item is invalid_citation',
      { cited_submission_id: 5 },
      'checked_out',
      'invalid_citation',
    ],
    ['a citation on a filed item is already_filed', { cited_album_id: 5 }, 'filed', 'already_filed'],
    ['a title-only patch on a surviving item is already_filed', { album_title: 'x' }, 'filed', 'already_filed'],
    ['a clear on a surviving item is already_filed', { cited_album_id: null }, 'pool', 'already_filed'],
  ])('%s', async (_name, patch, state, expected) => {
    expect(await refuse(patch, state)).toBe(expected);
  });
});

describe('RELEASE_ACCEPTED_REVIEW — the one UPDATE that takes a review off every accepting item (BS#2854)', () => {
  const rendered = db
    .update(intake_items)
    .set(RELEASE_ACCEPTED_REVIEW)
    .where(eq(intake_items.accepted_review_id, 3))
    .toSQL();
  const text = rendered.sql.toLowerCase();

  it('clears the three accept columns together and rewrites state in one statement', () => {
    expect(text).toMatch(
      /^update "[^"]+"\."intake_items" set "state" = case .* end, "accepted_review_id" = \$1, "accepted_by" = \$2, "accepted_at" = \$3 where /
    );
    expect(rendered.params.slice(0, 3)).toEqual([null, null, null]);
  });

  it('sends a reviewed item back to its checkout (checked_out_at set, holder account or not) else to the pool, and keeps every other state', () => {
    expect(text).toMatch(
      /case when .*"state" = 'reviewed' and .*"checked_out_at" is not null then 'checked_out' when .*"state" = 'reviewed' then 'pool' else .*"state" end/
    );
    expect(text).not.toContain('"checked_out_by"');
  });

  it('reaches every accepting item by the pointer and nothing else', () => {
    expect(text).toMatch(/where "[^"]+"\."intake_items"\."accepted_review_id" = \$4$/);
    expect(rendered.params[3]).toBe(3);
  });
});

describe('deleteIntakeItem (BS#2854)', () => {
  /** A chainable, awaitable stand-in for a drizzle builder: it resolves to `rows` and logs each method called on it. */
  const calls: string[] = [];
  const builder = (label: string, rows: unknown[]): unknown => {
    calls.push(label);
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(rows);
        return (...args: unknown[]) => {
          if (prop === 'for') calls.push(`${label} for ${args[0] as string}`);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const run = async (selects: unknown[][]) => {
    calls.length = 0;
    const tx = {
      select: jest.fn(() => builder('select', selects.shift() ?? [])),
      execute: jest.fn(() => Promise.resolve([{ authors: selects.shift()?.[0]?.authors }])),
      delete: jest.fn(() => builder('delete', [])),
    };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    return { result: await deleteIntakeItem(7), tx };
  };

  afterEach(() => jest.restoreAllMocks());

  it('locks the item first, reads the authors of every review (drafts included) through the shared fragment, then deletes, and answers the authors', async () => {
    const { result, tx } = await run([
      [{ state: 'checked_out' }],
      [{ authors: ['Test Reviewer', 'Test Visiting DJ'] }],
    ]);
    expect(result).toEqual({ outcome: 'deleted', authors: ['Test Reviewer', 'Test Visiting DJ'] });
    expect(calls).toEqual(['select', 'select for update', 'delete']);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });

  it.each(['filed', 'finalized'])(
    'a %s item is already_filed, with no read of authors and no delete',
    async (state) => {
      const { result, tx } = await run([[{ state }]]);
      expect(result).toEqual({ outcome: 'already_filed' });
      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(tx.delete).not.toHaveBeenCalled();
    }
  );

  it('a missing item is not_found', async () => {
    const { result, tx } = await run([[]]);
    expect(result).toEqual({ outcome: 'not_found' });
    expect(tx.delete).not.toHaveBeenCalled();
  });
});

describe('acceptReview (BS#2860)', () => {
  /** A chainable, awaitable stand-in for a drizzle builder: it resolves to `rows` and logs each `for` and write it sees. */
  const log: string[] = [];
  const sets: Record<string, unknown>[] = [];
  const builder = (label: string, rows: unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(rows);
        return (...args: unknown[]) => {
          if (prop === 'for') log.push(`${label} for ${args[0] as string}`);
          if (prop === 'set') sets.push(args[0] as Record<string, unknown>);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const dialect = new PgDialect();
  const MD = { id: 'md-1', manage: true };
  const own = { status: 'submitted', medium: 'typed', item: 7, album: null };
  type Row = Record<string, unknown>;
  /** Selects resolve in call order: the item's citation, the review's album, [the cited library row], the item lock, the review lock. */
  const run = async (opts: {
    cited?: number | null;
    peekAlbum?: number | null;
    item?: Row;
    review?: Row | undefined;
  }) => {
    log.length = 0;
    sets.length = 0;
    const cited = opts.cited ?? null;
    const item = opts.item ?? { album_id: null, cited };
    const selects: unknown[][] = [[{ cited }], [{ album: opts.peekAlbum ?? null }]];
    if (cited !== null && opts.peekAlbum === cited) selects.push([{ id: cited }]);
    selects.push([item], opts.review === undefined ? [] : [opts.review]);
    const tx = {
      select: jest.fn(() => builder('select', selects.shift() ?? [])),
      update: jest.fn(() => builder('update', [])),
    };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    jest.spyOn(db, 'select').mockReturnValue(builder('read', [{ id: 7 }]) as never);
    return { result: await acceptReview(7, 3, MD), tx };
  };

  afterEach(() => jest.restoreAllMocks());

  it('locks the item FOR UPDATE, then the review FOR UPDATE, and writes once', async () => {
    const { result, tx } = await run({ review: own });
    expect(result.outcome).toBe('accepted');
    expect(log).toEqual(['select for update', 'select for update']);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('through a citation takes the cited release library row FOR SHARE before the item and the review locks', async () => {
    const { result } = await run({
      cited: 9,
      peekAlbum: 9,
      review: { status: 'submitted', medium: 'typed', item: null, album: 9 },
    });
    expect(result.outcome).toBe('accepted');
    expect(log).toEqual(['select for share', 'select for update', 'select for update']);
  });

  it('writes the pointer, the caller and now, withdraws any request, and sets reviewed unless filed or finalized, in one statement', async () => {
    await run({ review: own });
    const set = dialect.sqlToQuery(sql`${sets[0].state}`);
    expect(set.sql).toMatch(/CASE WHEN .*"state" IN \('filed', 'finalized'\) THEN .*"state" ELSE 'reviewed' END/);
    expect(sets[0]).toMatchObject({
      accepted_review_id: 3,
      accepted_by: 'md-1',
      requested_dj_id: null,
      requested_at: null,
    });
    expect(Object.keys(sets[0])).not.toEqual(expect.arrayContaining(['checked_out_by', 'checked_out_at']));
  });

  it.each([['the item is missing', { cited: null, item: undefined }, 'not_found']])('%s', async () => {
    log.length = 0;
    const tx = { select: jest.fn(() => builder('select', [])), update: jest.fn() };
    jest.spyOn(db, 'transaction').mockImplementation((cb: never) => (cb as (t: unknown) => unknown)(tx) as never);
    expect((await acceptReview(7, 3, MD)).outcome).toBe('not_found');
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing review', undefined],
    ['a draft of this item', { ...own, status: 'draft' }],
    ['a review of another record', { status: 'submitted', medium: 'typed', item: 8, album: null }],
    [
      'a review of another unfiled record when this item is unfiled (both album_ids NULL)',
      { status: 'submitted', medium: 'handwritten', item: null, album: null },
    ],
  ])('%s is bad_review and writes nothing', async (_name, review) => {
    const { result, tx } = await run({ review });
    expect(result).toEqual({ outcome: 'bad_review' });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a typed review of the release the item was filed as',
      { album_id: 5, cited: null },
      { status: 'submitted', medium: 'typed', item: null, album: 5 },
      true,
    ],
    [
      'a handwritten review of the release the item was filed as',
      { album_id: 5, cited: null },
      { status: 'submitted', medium: 'handwritten', item: null, album: 5 },
      true,
    ],
    [
      'a handwritten review of the cited release',
      { album_id: null, cited: 9 },
      { status: 'submitted', medium: 'handwritten', item: null, album: 9 },
      false,
    ],
    [
      'a draft of the cited release',
      { album_id: null, cited: 9 },
      { status: 'draft', medium: 'typed', item: null, album: 9 },
      false,
    ],
    [
      'a review of a release the item does not cite',
      { album_id: null, cited: 9 },
      { status: 'submitted', medium: 'typed', item: null, album: 4 },
      false,
    ],
  ])('%s is %s', async (_name, item, review, accepted) => {
    const { result } = await run({ cited: item.cited, peekAlbum: review.album, item, review });
    expect(result.outcome).toBe(accepted ? 'accepted' : 'bad_review');
  });

  it('honors the citation arm only for the release it holds a lock on: a citation changed after the unlocked read is bad_review', async () => {
    const { result } = await run({
      cited: 9,
      peekAlbum: 9,
      item: { album_id: null, cited: 4 },
      review: { status: 'submitted', medium: 'typed', item: null, album: 9 },
    });
    expect(result.outcome).toBe('bad_review');
  });
});
