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
  return { ...realSchema, db: drizzle({}) };
});

import { buildIntakeSelect } from '../../../apps/backend/services/intake.service';

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
      `${t}."state" = 'requested' and (${t}."requested_dj_id" is null or ${t}."requested_at" < now() - interval '7 days') then 'pool'`
    );
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
