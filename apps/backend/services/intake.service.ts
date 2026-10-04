import { and, desc, eq, getTableColumns, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  db,
  extractSqlState,
  intake_item_passes,
  intake_items,
  intakeItemStateEnum,
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
 * because that DJ's account was deleted, reads as `pool`. A `checked_out` item
 * past 14 days is `overdue`. Reads never write: the stale request fields are
 * cleared by the next write to the row, not by a GET.
 */

export type IntakeItemState = (typeof intakeItemStateEnum.enumValues)[number];

/** States past which an item is catalogued, so it can no longer be edited or deleted. */
const FILED_STATES: IntakeItemState[] = ['filed', 'finalized'];

/** Audit columns the contract's `IntakeItem` does not carry. */
const UNEXPOSED = new Set(['logged_by', 'filed_by', 'printed_by', 'finalized_by']);

const effectiveState = sql<IntakeItemState>`CASE WHEN ${intake_items.state} = 'requested' AND (${intake_items.requested_dj_id} IS NULL OR ${intake_items.requested_at} < now() - interval '7 days') THEN 'pool' ELSE ${intake_items.state}::text END`;
const overdue = sql<boolean>`(${intake_items.state} = 'checked_out' AND ${intake_items.checked_out_at} < now() - interval '14 days')`;

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

/** Logs an item into `pool`; `logged_at` takes its column default. `unknown_reference` is a `format_id`/`label_id` FK miss (23503). */
export const logIntakeItem = async (fields: IntakeFields, loggedBy: string) => {
  try {
    const [{ id }] = await db
      .insert(intake_items)
      .values({ ...fields, logged_by: loggedBy })
      .returning({ id: intake_items.id });
    return { outcome: 'logged' as const, item: (await getIntakeItem(id, true))! };
  } catch (error) {
    if (extractSqlState(error) === '23503') return { outcome: 'unknown_reference' as const };
    throw error;
  }
};

/**
 * One `UPDATE … WHERE not filed RETURNING`: the precondition is part of the
 * write, never a read first. Zero rows means missing or filed, and a follow-up
 * lookup only chooses between the 404 and the 409 — it gates nothing.
 */
const refusalFor = async (id: number) =>
  (await getIntakeItem(id, false)) ? ('already_filed' as const) : ('not_found' as const);

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
    if (extractSqlState(error) === '23503') return { outcome: 'unknown_reference' as const };
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
