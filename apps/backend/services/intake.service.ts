import { and, desc, eq, getTableColumns, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  db,
  extractConstraintName,
  extractSqlState,
  intake_item_passes,
  intake_items,
  intakeItemStateEnum,
  member,
  user,
  type NewIntakeItem,
} from '@wxyc/database';

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
const FILED_STATES: IntakeItemState[] = ['filed', 'finalized'];

/** Audit columns the contract's `IntakeItem` does not carry. */
const UNEXPOSED = new Set(['logged_by', 'filed_by', 'printed_by', 'finalized_by']);

const effectiveState = sql<IntakeItemState>`CASE WHEN ${intake_items.state} = 'requested' AND (${intake_items.requested_dj_id} IS NULL OR ${intake_items.requested_at} IS NULL OR ${intake_items.requested_at} < now() - interval '7 days') THEN 'pool' ELSE ${intake_items.state}::text END`;
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
 * Missing is a 404. For `updateIntakeItem`/`deleteIntakeItem` (the UPDATE's only
 * precondition is "not filed") any surviving item is `already_filed`. For a
 * transition, an item still in the right effective state that the identity
 * condition refused belongs to someone else (`forbidden`); every other state,
 * filed included, is `state_changed`.
 */
const refusalFor = async (id: number, transition?: IntakeTransitionRefusal) =>
  refusalOutcome(await getIntakeItem(id, false), transition);

type IntakeTransitionRefusal = { from: IntakeItemState; identityGuarded: boolean };

/**
 * The pure decision behind `refusalFor`, split out so its precedence is testable without a database:
 * missing is `not_found`; no transition is `already_filed`; otherwise an identity-guarded refusal on an item still in
 * the `from` effective state is `forbidden` and anything else is `state_changed`, which therefore outranks the identity 403.
 */
export const refusalOutcome = (
  item: Pick<IntakeItemResponse, 'effective_state'> | undefined,
  transition?: IntakeTransitionRefusal
) => {
  if (!item) return 'not_found' as const;
  if (!transition) return 'already_filed' as const;
  return transition.identityGuarded && item.effective_state === transition.from
    ? ('forbidden' as const)
    : ('state_changed' as const);
};

export const updateIntakeItem = async (id: number, patch: Partial<IntakeFields>) => {
  try {
    const rows = await db
      .update(intake_items)
      .set(patch)
      .where(and(eq(intake_items.id, id), notInArray(intake_items.state, FILED_STATES)))
      .returning({ id: intake_items.id });
    if (rows.length === 0) return { outcome: await refusalFor(id) };
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
export type IntakeActor = { id: string; manage: boolean };

const CLEAR_REQUEST = { requested_dj_id: null, requested_at: null };
const TAKEN = (actor: IntakeActor) => ({
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
    set: (actor: IntakeActor, djId?: string) => PgUpdateSetSource<typeof intake_items>;
    only?: (actor: IntakeActor) => SQL | undefined;
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
  actor: IntakeActor,
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
export const transitionIntakeItem = async (action: IntakeAction, id: number, actor: IntakeActor, djId?: string) => {
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
