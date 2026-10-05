import { and, desc, eq, getTableColumns, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  db,
  extractConstraintName,
  extractSqlState,
  intake_item_passes,
  intake_items,
  intakeItemStateEnum,
  library,
  member,
  NY_TIME_ZONE,
  album_review_submissions,
  reviews,
  user,
  type NewIntakeItem,
} from '@wxyc/database';
import WxycError from '../utils/error.js';
import type { ReviewsActor } from '../utils/review-grants.js';
import { reviewGateCutoverDate } from '../utils/review-gate-cutover.js';

/**
 * Intake-item service behind `/intake` (BS#2796, slice 7 of BS#2791).
 *
 * EFFECTIVE STATE is defined once, here, as a SQL expression: the list filter,
 * the `effective_state` the response carries and (from slice 8) every
 * transition's precondition all read this one definition. A `requested` item
 * whose request is more than 7 days old, or whose `requested_dj_id` is NULL
 * because that DJ's account was deleted (or whose `requested_at` is NULL, so
 * there is no age to measure), reads as `pool`. A `checked_out` item
 * past 14 days is `overdue`. Reads never write, and neither does PATCH:
 * the stale request fields are cleared by the next transition that writes them —
 * checkout, request, cancel-request, accept or pass — never by a GET or an edit.
 */

export type IntakeItemState = (typeof intakeItemStateEnum.enumValues)[number];

/** States past which an item is catalogued, so it can no longer be edited or deleted. */
export const FILED_STATES: IntakeItemState[] = ['filed', 'finalized'];

/** Audit columns the contract's `IntakeItem` does not carry. */
const UNEXPOSED = new Set(['logged_by', 'filed_by', 'printed_by', 'finalized_by']);

export const effectiveState = sql<IntakeItemState>`CASE WHEN ${intake_items.state} = 'requested' AND (${intake_items.requested_dj_id} IS NULL OR ${intake_items.requested_at} IS NULL OR ${intake_items.requested_at} < now() - interval '7 days') THEN 'pool' ELSE ${intake_items.state}::text END`;
// coalesce: no CHECK ties checked_out_at to the state, and a NULL stamp must read false, never SQL NULL.
const overdue = sql<boolean>`coalesce(${intake_items.state} = 'checked_out' AND ${intake_items.checked_out_at} < now() - interval '14 days', false)`;

/** Mirror of the contract's `IntakeItem` (`wxyc-shared/api.yaml`); private because Backend-Service stays on `@wxyc/shared` 5.x. Timestamps serialize to ISO strings. */
export type IntakeItemResponse = Omit<
  typeof intake_items.$inferSelect,
  'logged_by' | 'filed_by' | 'printed_by' | 'finalized_by'
> & {
  effective_state: IntakeItemState;
  overdue: boolean;
  requested_dj_name: string | null;
  checked_out_by_name: string | null;
  passes?: { dj_name: string; passed_at: string }[];
};

export type IntakeFields = Pick<
  NewIntakeItem,
  'artist_name' | 'album_title' | 'record_label' | 'label_id' | 'format_id' | 'discogs_release_id'
>;

/** The two citation kinds, mutually exclusive (the table's CHECK); `null` clears one. */
export type IntakeCitations = Pick<NewIntakeItem, 'cited_album_id' | 'cited_submission_id'>;

/**
 * Every item column the contract exposes, plus the DJ display names. Names are
 * `auth_user.name` — the public-safe value — and `real_name` is never selected.
 * `passes` is a correlated aggregate in the same statement (one query for the
 * whole list, not one per item) and is only present when `includePasses`.
 */
export const buildIntakeSelect = (opts: { state?: IntakeItemState; id?: number; includePasses: boolean }) => {
  const requester = alias(user, 'requester');
  const holder = alias(user, 'holder');
  const exposed = Object.fromEntries(Object.entries(getTableColumns(intake_items)).filter(([k]) => !UNEXPOSED.has(k)));
  const passes = sql<
    IntakeItemResponse['passes']
  >`(SELECT coalesce(json_agg(json_build_object('dj_name', ${user.name}, 'passed_at', ${intake_item_passes.passed_at}) ORDER BY ${intake_item_passes.passed_at}, ${intake_item_passes.id}), '[]'::json) FROM ${intake_item_passes} JOIN ${user} ON ${user.id} = ${intake_item_passes.dj_id} WHERE ${intake_item_passes.intake_item_id} = ${intake_items.id})`;
  return db
    .select({
      ...exposed,
      effective_state: effectiveState.as('effective_state'),
      overdue: overdue.as('overdue'),
      requested_dj_name: requester.name,
      checked_out_by_name: holder.name,
      ...(opts.includePasses && { passes: passes.as('passes') }),
    })
    .from(intake_items)
    .leftJoin(requester, eq(requester.id, intake_items.requested_dj_id))
    .leftJoin(holder, eq(holder.id, intake_items.checked_out_by))
    .where(
      and(
        opts.state === undefined ? undefined : sql`(${effectiveState}) = ${opts.state}`,
        opts.id === undefined ? undefined : eq(intake_items.id, opts.id)
      )
    )
    .orderBy(desc(intake_items.logged_at), desc(intake_items.id));
};

export const listIntakeItems = (filters: { state?: IntakeItemState; includePasses: boolean }) =>
  buildIntakeSelect(filters) as unknown as Promise<IntakeItemResponse[]>;

export const getIntakeItem = async (id: number, includePasses: boolean): Promise<IntakeItemResponse | undefined> =>
  ((await buildIntakeSelect({ id, includePasses })) as unknown as IntakeItemResponse[])[0];

/** A `format_id`/`label_id` FK miss. A `logged_by` miss (the caller's own account is gone) is not the caller's input, so it stays a 500. */
const isUnknownReference = (error: unknown) =>
  extractSqlState(error) === '23503' && !extractConstraintName(error)?.includes('logged_by');

/** Logs an item into `pool`; `logged_at` takes its column default. `unknown_reference` is a `format_id`/`label_id` FK miss (23503). */
export const logIntakeItem = async (fields: IntakeFields, loggedBy: string) => {
  try {
    const [{ id }] = await db
      .insert(intake_items)
      .values({ ...fields, logged_by: loggedBy })
      .returning({ id: intake_items.id });
    return { outcome: 'logged' as const, item: (await getIntakeItem(id, true))! };
  } catch (error) {
    if (isUnknownReference(error)) return { outcome: 'unknown_reference' as const };
    throw error;
  }
};

/**
 * The zero-row follow-up read, which only chooses the answer and gates nothing.
 * Missing is a 404. For `updateIntakeItem`/`deleteIntakeItem` (the UPDATE's
 * preconditions are "not filed" and, when a citation is set, "the citation is valid") any surviving item is
 * `already_filed`, except that a PATCH setting a citation (`'citation'`) answers `invalid_citation` for an unfiled one. For a
 * transition, an item still in the right effective state that the identity
 * condition refused belongs to someone else (`forbidden`); every other state,
 * filed included, is `state_changed`.
 */
const refusalFor = async (id: number, transition?: IntakeTransitionRefusal | 'citation') =>
  refusalOutcome(await getIntakeItem(id, false), transition);

type IntakeTransitionRefusal = { from: IntakeItemState; identityGuarded: boolean };

/**
 * The pure decision behind `refusalFor`, split out so its precedence is testable without a database:
 * missing is `not_found`; no transition is `already_filed`; `'citation'` (a PATCH that sets a citation) is `already_filed`
 * for a filed item (it can't be edited at all, so that outranks the citation) and otherwise `invalid_citation`; otherwise an identity-guarded refusal on an item still in
 * the `from` effective state is `forbidden` and anything else is `state_changed`, which therefore outranks the identity 403.
 */
export const refusalOutcome = (
  item: Pick<IntakeItemResponse, 'effective_state'> | undefined,
  transition?: IntakeTransitionRefusal | 'citation'
) => {
  if (!item) return 'not_found' as const;
  if (transition === 'citation') {
    return FILED_STATES.includes(item.effective_state) ? ('already_filed' as const) : ('invalid_citation' as const);
  }
  if (!transition) return 'already_filed' as const;
  return transition.identityGuarded && item.effective_state === transition.from
    ? ('forbidden' as const)
    : ('state_changed' as const);
};

const NY = sql.raw(`'${NY_TIME_ZONE}'`);

/**
 * The citation rule as a WHERE fragment (`undefined` when the patch sets none), so validity is
 * decided in the write itself. A release is citable with a submitted review (a draft doesn't count) or when
 * catalogued on or before the cutover; a submission when dated, in station time, on or before it. Unset cutover
 * admits any existing row. Mirrors `isOnOrBeforeCutover` (the `timestamptz` → station date conversion).
 */
export const citationValidSql = ({ cited_album_id: album, cited_submission_id: submission }: IntakeCitations) => {
  // Read the cutover date only when a citation is being set, so other edits never touch the variable.
  const onOrBefore = (column: SQL) => {
    const cutover = reviewGateCutoverDate();
    return cutover === null ? sql`true` : sql`(${column} AT TIME ZONE ${NY})::date <= ${cutover}::date`;
  };
  if (album != null) {
    return sql`(EXISTS (SELECT 1 FROM ${reviews} WHERE ${reviews.album_id} = ${album} AND ${reviews.status} = 'submitted') OR EXISTS (SELECT 1 FROM ${library} WHERE ${library.id} = ${album} AND ${onOrBefore(sql`${library.add_date}`)}))`;
  }
  if (submission != null) {
    return sql`EXISTS (SELECT 1 FROM ${album_review_submissions} WHERE ${album_review_submissions.id} = ${submission} AND ${onOrBefore(sql`${album_review_submissions.submitted_at}`)})`;
  }
  return undefined;
};

/** Whether the patch sets a citation to a non-null value (a clear, or no citation key, sets none). */
const setsCitation = (patch: IntakeCitations) => patch.cited_album_id != null || patch.cited_submission_id != null;

/** Throws a 400 `WxycError` when both citations are non-null: the two are mutually exclusive, so the service refuses it as well as the controller. */
export const buildIntakePatch = (id: number, patch: Partial<IntakeFields> & IntakeCitations) => {
  if (patch.cited_album_id != null && patch.cited_submission_id != null) {
    throw new WxycError('cited_album_id and cited_submission_id cannot both be set', 400);
  }
  return db
    .update(intake_items)
    .set({
      ...patch,
      // Setting one citation clears the other, in the same UPDATE.
      ...(patch.cited_album_id != null && { cited_submission_id: null }),
      ...(patch.cited_submission_id != null && { cited_album_id: null }),
    })
    .where(and(eq(intake_items.id, id), notInArray(intake_items.state, FILED_STATES), citationValidSql(patch)))
    .returning({ id: intake_items.id });
};

export const updateIntakeItem = async (id: number, patch: Partial<IntakeFields> & IntakeCitations) => {
  const query = buildIntakePatch(id, patch); // throws the 400 before any write
  try {
    const rows = await query;
    if (rows.length === 0) {
      return { outcome: await refusalFor(id, setsCitation(patch) ? 'citation' : undefined) };
    }
    return { outcome: 'updated' as const, item: (await getIntakeItem(id, true))! };
  } catch (error) {
    if (isUnknownReference(error)) return { outcome: 'unknown_reference' as const };
    throw error;
  }
};

/** Passes cascade with the item. Reviews can't attach until slice 9, so none go with it yet. */
export const deleteIntakeItem = async (id: number) => {
  const rows = await db
    .delete(intake_items)
    .where(and(eq(intake_items.id, id), notInArray(intake_items.state, FILED_STATES)))
    .returning({ id: intake_items.id });
  return { outcome: rows.length === 0 ? await refusalFor(id) : ('deleted' as const) };
};

export type IntakeAction = 'checkout' | 'release' | 'request' | 'cancel_request' | 'accept' | 'pass';
/** The caller; `manage` is whether they hold `reviews: manage`. */

const CLEAR_REQUEST = { requested_dj_id: null, requested_at: null };
const TAKEN = (actor: ReviewsActor) => ({
  state: 'checked_out' as const,
  ...CLEAR_REQUEST,
  checked_out_by: actor.id,
  checked_out_at: sql`now()`,
});
const TO_POOL = { state: 'pool' as const, ...CLEAR_REQUEST };

/**
 * `from` is an EFFECTIVE state. `only` is the identity condition, which goes
 * in the UPDATE's WHERE: authorizing against a prior read would let A's release
 * match B's checkout taken in between.
 */
const TRANSITIONS: Record<
  IntakeAction,
  {
    from: IntakeItemState;
    set: (actor: ReviewsActor, djId?: string) => PgUpdateSetSource<typeof intake_items>;
    only?: (actor: ReviewsActor) => SQL | undefined;
  }
> = {
  checkout: { from: 'pool', set: TAKEN },
  release: {
    from: 'checked_out',
    set: () => ({ state: 'pool', checked_out_by: null, checked_out_at: null }),
    only: (actor) => (actor.manage ? undefined : eq(intake_items.checked_out_by, actor.id)),
  },
  request: {
    from: 'pool',
    set: (_, djId) => ({ state: 'requested', requested_dj_id: djId, requested_at: sql`now()` }),
  },
  cancel_request: { from: 'requested', set: () => TO_POOL },
  accept: { from: 'requested', set: TAKEN, only: (actor) => eq(intake_items.requested_dj_id, actor.id) },
  pass: { from: 'requested', set: () => TO_POOL, only: (actor) => eq(intake_items.requested_dj_id, actor.id) },
};

export const buildTransition = (
  action: IntakeAction,
  id: number,
  actor: ReviewsActor,
  djId?: string,
  executor: Pick<typeof db, 'update'> = db
) => {
  const t = TRANSITIONS[action];
  return executor
    .update(intake_items)
    .set(t.set(actor, djId))
    .where(and(eq(intake_items.id, id), sql`(${effectiveState}) = ${t.from}`, t.only?.(actor)))
    .returning({ id: intake_items.id });
};

/** One `UPDATE … WHERE <effective-state precondition> [AND identity] RETURNING`; a pass records its row in the same transaction. */
export const transitionIntakeItem = async (action: IntakeAction, id: number, actor: ReviewsActor, djId?: string) => {
  const rows =
    action === 'pass'
      ? await db.transaction(async (tx) => {
          const updated = await buildTransition(action, id, actor, djId, tx);
          if (updated.length > 0) await tx.insert(intake_item_passes).values({ intake_item_id: id, dj_id: actor.id });
          return updated;
        })
      : await buildTransition(action, id, actor, djId);
  if (rows.length > 0) return { outcome: 'updated' as const, item: (await getIntakeItem(id, actor.manage))! };
  const { from, only } = TRANSITIONS[action];
  return { outcome: await refusalFor(id, { from, identityGuarded: !!only?.(actor) }) };
};

/** The `auth_member` roles of an account — empty when the account is unknown or has no membership. */
export const memberRoles = async (userId: string) =>
  (await db.select({ role: member.role }).from(member).where(eq(member.userId, userId))).map((r) => r.role);
