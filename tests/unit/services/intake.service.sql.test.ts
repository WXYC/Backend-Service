/**
 * Genuinely-rendered-SQL pins for the `/intake` reads (BS#2796).
 *
 * Effective state is the one definition the list filter, the lanes and (from
 * slice 8) every transition's precondition share, so what these pin is its
 * shape: a stale `requested` row reads as `pool` after 7 days or when the
 * requested DJ's account is gone, and a `checked_out` row is overdue after 14
 * days. The real-Postgres behavior (a stale row listed as `pool` and left
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

import {
  buildIntakePatch,
  buildIntakeSelect,
  buildTransition,
  refusalOutcome,
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

  it('flags overdue only on checked_out rows older than 14 days, without touching state', () => {
    expect(text).toContain(`"${SCHEMA}"."intake_items"."state" = 'checked_out'`);
    expect(text).toContain(`"${SCHEMA}"."intake_items"."checked_out_at" < now() - interval '14 days'`);
  });

  it('makes overdue false, never NULL, for a checked_out row with no checked_out_at', () => {
    const t = `"${SCHEMA}"."intake_items"`;
    expect(text).toContain(
      `coalesce(${t}."state" = 'checked_out' and ${t}."checked_out_at" < now() - interval '14 days', false) as "overdue"`
    );
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

describe('buildTransition (BS#2798)', () => {
  const t = `"${SCHEMA}"."intake_items"`;
  const dj = { id: 'dj-1', manage: false };
  const md = { id: 'md-1', manage: true };
  const render = (...args: Parameters<typeof buildTransition>) => {
    const q = buildTransition(...args).toSQL();
    return { text: q.sql.toLowerCase(), params: q.params };
  };

  it.each([
    ['checkout', 'pool'],
    ['release', 'checked_out'],
    ['request', 'pool'],
    ['cancel_request', 'requested'],
    ['accept', 'requested'],
    ['pass', 'requested'],
  ] as const)('%s is one UPDATE whose WHERE carries the id and the effective-state precondition %s', (action, from) => {
    const { text, params } = render(action, 7, md, 'dj-2');
    expect(text.trimStart()).toMatch(/^update /);
    expect(text).toMatch(/where \(.*"id" = \$\d+ and \(case when .* end\) = \$\d+/s);
    expect(text).toContain('returning');
    expect(params).toEqual(expect.arrayContaining([7, from]));
  });

  it('checkout stamps the holder and clears any stale request fields', () => {
    const { text, params } = render('checkout', 7, dj);
    expect(text).toMatch(
      /set "state" = \$\d+, "requested_dj_id" = \$\d+, "requested_at" = \$\d+, "checked_out_by" = \$\d+, "checked_out_at" = now\(\)/
    );
    expect(params).toEqual(expect.arrayContaining(['checked_out', null, 'dj-1']));
  });

  it('release clears the holder fields', () => {
    const { text, params } = render('release', 7, md);
    expect(text).toMatch(/set "state" = \$\d+, "checked_out_by" = \$\d+, "checked_out_at" = \$\d+/);
    expect(params.slice(0, 3)).toEqual(['pool', null, null]);
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
      { from: 'checked_out', identityGuarded: true },
      'forbidden',
    ],
    [
      'an identity-guarded transition on an item in another state',
      { effective_state: 'pool' },
      { from: 'checked_out', identityGuarded: true },
      'state_changed',
    ],
    [
      'an identity-guarded transition on a filed item',
      { effective_state: 'filed' },
      { from: 'requested', identityGuarded: true },
      'state_changed',
    ],
    [
      'an unguarded transition on an item in the from state',
      { effective_state: 'pool' },
      { from: 'pool', identityGuarded: false },
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
    expect(text).toContain(`${T}."reviews"."status" = 'submitted'`);
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
    expect(text).not.toContain('"reviews"');
  });

  it.each([
    ['a release clears the submission', { cited_album_id: 5 }, 'cited_submission_id'],
    ['a submission clears the release', { cited_submission_id: 12 }, 'cited_album_id'],
  ])('setting %s in the same statement', (_name, patch, cleared) => {
    const { sql: text } = render(patch, '2027-01-12');
    expect(text).toContain(`"${cleared}" = $`);
  });

  it('adds no citation predicate, and clears nothing, for a patch that sets none', () => {
    const { sql: text } = render({ album_title: 'DOGA', cited_album_id: null });
    expect(text).not.toContain('exists');
    expect(text).not.toContain('cited_submission_id');
  });
});
