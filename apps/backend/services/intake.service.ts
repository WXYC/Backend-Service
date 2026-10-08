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
  fcc_notes,
  review_prints,
  reviews,
  rotation,
  rotationActiveSql,
  staffNameSql,
  user,
  type NewIntakeItem,
} from '@wxyc/database';
import WxycError from '../utils/error.js';
import { fileLibraryRelease, mapLibraryFilingError, type ValidatedFilingInput } from './library-filing.service.js';
import { outerRef } from '../utils/sql-fragments.js';
import type { ReviewsActor } from '../utils/review-grants.js';
import { reviewGateCutoverDate } from '../utils/review-gate-cutover.js';
import { mayFileItem } from '../utils/intake-filing-rule.js';
import { lockReleaseRow } from '../utils/release-row-lock.js';
import type { RecordSubject } from '../utils/record-subject.js';

export { mayFileItem, lockReleaseRow };

/**
 * Intake-item service behind `/intake` (BS#2796, slice 7 of BS#2791).
 *
 * EFFECTIVE STATE is defined once, here, as a SQL expression: the list filter,
 * the `effective_state` the response carries and (from slice 8) every
 * transition's precondition all read this one definition. A `requested` item
 * whose request is more than 7 days old, or whose `requested_dj_id` is NULL
 * because that DJ's account was deleted (or whose `requested_at` is NULL, so
 * there is no age to measure), reads as `pool`. An item whose checkout
 * (`checked_out_at`) is past 14 days is `overdue`, `checked_out` or `reviewed` alike. Reads never write, and neither does PATCH:
 * the stale request fields are cleared by the next transition that writes them —
 * checkout, request, cancel-request, accept or pass — never by a GET or an edit.
 */

export type IntakeItemState = (typeof intakeItemStateEnum.enumValues)[number];

/** States past which an item is catalogued, so it can no longer be edited or deleted. */
export const FILED_STATES: IntakeItemState[] = ['filed', 'finalized'];

/** Columns the contract's `IntakeItem` does not carry: the audit columns. */
const UNEXPOSED = new Set(['logged_by', 'filed_by', 'printed_by', 'finalized_by']);

export const effectiveState = sql<IntakeItemState>`CASE WHEN ${intake_items.state} = 'requested' AND (${intake_items.requested_dj_id} IS NULL OR ${intake_items.requested_at} IS NULL OR ${intake_items.requested_at} < now() - interval '7 days') THEN 'pool' ELSE ${intake_items.state}::text END`;
// coalesce: no CHECK ties checked_out_at to the state, and a NULL stamp must read false, never SQL NULL.
const overdue = sql<boolean>`coalesce(${intake_items.checked_out_at} < now() - interval '14 days', false)`;
export const submittedReviewCount = sql<number>`(SELECT count(*)::int FROM ${reviews} WHERE ${reviews.intake_item_id} = ${outerRef(intake_items.id)} AND ${reviews.status} = 'submitted')`;

/** The passes on an item as a JSON array, correlated on the outer `intake_items.id` through `outerRef` so it stays correct in a single-table select. */
export const passesSql = sql<
  IntakeItemResponse['passes']
>`(SELECT coalesce(json_agg(json_build_object('dj_name', ${staffNameSql(user)}, 'passed_at', ${intake_item_passes.passed_at}) ORDER BY ${intake_item_passes.passed_at}, ${intake_item_passes.id}), '[]'::json) FROM ${intake_item_passes} JOIN ${user} ON ${user.id} = ${intake_item_passes.dj_id} WHERE ${intake_item_passes.intake_item_id} = ${outerRef(intake_items.id)})`;

/**
 * The `author` of each review on the item, as a JSON array correlated on `intake_items.id`: oldest first by
 * `reviews.id`, a review with no author text left out, `[]` when there are none, and only drafts with
 * `draftsOnly`. The one definition behind both lists a music director sees, `draft_authors` on the item and
 * `deleted_review_authors` on its delete, so they cannot disagree about which drafts exist. Names only, never content.
 */
export const reviewAuthorsSql = (draftsOnly = false) =>
  sql<
    string[]
  >`(SELECT coalesce(json_agg(${reviews.author} ORDER BY ${reviews.id}) FILTER (WHERE ${reviews.author} IS NOT NULL), '[]'::json) FROM ${reviews} WHERE ${reviews.intake_item_id} = ${outerRef(intake_items.id)}${draftsOnly ? sql` AND ${reviews.status} = 'draft'` : sql``})`;

/** Mirror of the contract's `IntakeItem` (`wxyc-shared/api.yaml`); private because Backend-Service stays on `@wxyc/shared` 5.x. Timestamps serialize to ISO strings. */
export type IntakeItemResponse = Omit<
  typeof intake_items.$inferSelect,
  'logged_by' | 'filed_by' | 'printed_by' | 'finalized_by'
> & {
  effective_state: IntakeItemState;
  overdue: boolean;
  submitted_review_count: number;
  draft_authors?: string[];
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
 * Every item column the contract exposes, plus the staff names (`requested_dj_name`, `checked_out_by_name`, `passes[].dj_name`).
 * Each is `staffNameSql`: the person's real name, else `auth_user.name`; read at request time, never stored. Only `reviews:read`
 * callers reach this, so the real name goes to staff and never to a public read (docs/pii.md).
 * `passes` and `draft_authors` are correlated aggregates in the same statement (one query for the
 * whole list, not one per item) and are only present when `includePasses` (the caller holds `reviews: manage`).
 * `awaitingAcceptance` keeps items with a submitted review, no accepted one, and no filing.
 */
export const buildIntakeSelect = (opts: {
  state?: IntakeItemState;
  id?: number;
  includePasses: boolean;
  awaitingAcceptance?: boolean;
}) => {
  const requester = alias(user, 'requester');
  const holder = alias(user, 'holder');
  const exposed = Object.fromEntries(Object.entries(getTableColumns(intake_items)).filter(([k]) => !UNEXPOSED.has(k)));
  return db
    .select({
      ...exposed,
      effective_state: effectiveState.as('effective_state'),
      overdue: overdue.as('overdue'),
      submitted_review_count: submittedReviewCount.as('submitted_review_count'),
      requested_dj_name: staffNameSql(requester).as('requested_dj_name'),
      checked_out_by_name: staffNameSql(holder).as('checked_out_by_name'),
      ...(opts.includePasses && {
        passes: passesSql.as('passes'),
        draft_authors: reviewAuthorsSql(true).as('draft_authors'),
      }),
    })
    .from(intake_items)
    .leftJoin(requester, eq(requester.id, intake_items.requested_dj_id))
    .leftJoin(holder, eq(holder.id, intake_items.checked_out_by))
    .where(
      and(
        opts.state === undefined ? undefined : sql`(${effectiveState}) = ${opts.state}`,
        opts.id === undefined ? undefined : eq(intake_items.id, opts.id),
        opts.awaitingAcceptance
          ? and(
              sql`${submittedReviewCount} > 0`,
              sql`${intake_items.accepted_review_id} IS NULL`,
              notInArray(intake_items.state, FILED_STATES)
            )
          : undefined
      )
    )
    .orderBy(desc(intake_items.logged_at), desc(intake_items.id));
};

export const listIntakeItems = (filters: Parameters<typeof buildIntakeSelect>[0]) =>
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
 * Missing is a 404. For `updateIntakeItem` (the UPDATE's
 * preconditions are "not filed" and, when a citation is set, "the citation is valid") any surviving item is
 * `already_filed`, except that a PATCH setting a citation (`'citation'`) answers `invalid_citation` for an unfiled one. For a
 * transition, an item still in the right effective state that the identity
 * condition refused belongs to someone else (`forbidden`); every other state,
 * filed included, is `state_changed`.
 */
const refusalFor = async (id: number, transition?: IntakeTransitionRefusal | 'citation') =>
  refusalOutcome(await getIntakeItem(id, false), transition);

type IntakeTransitionRefusal = { from: IntakeItemState[]; identityGuarded: boolean };

/**
 * The pure decision behind `refusalFor`, split out so its precedence is testable without a database:
 * missing is `not_found`; no transition is `already_filed`; `'citation'` (a PATCH that sets a citation) is `already_filed`
 * for a filed item (it can't be edited at all, so that outranks the citation) and otherwise `invalid_citation`; otherwise an identity-guarded refusal on an item still in
 * one of the `from` effective states is `forbidden` and anything else is `state_changed`, which therefore outranks the identity 403.
 * A `reviewed` item with no checkout (`checked_out_at` null) has nothing to return, so it is `state_changed` for every caller.
 */
export const refusalOutcome = (
  item: Pick<IntakeItemResponse, 'effective_state' | 'checked_out_at'> | undefined,
  transition?: IntakeTransitionRefusal | 'citation'
) => {
  if (!item) return 'not_found' as const;
  if (transition === 'citation') {
    return FILED_STATES.includes(item.effective_state) ? ('already_filed' as const) : ('invalid_citation' as const);
  }
  if (!transition) return 'already_filed' as const;
  if (item.effective_state === 'reviewed' && item.checked_out_at === null) return 'state_changed' as const;
  return transition.identityGuarded && transition.from.includes(item.effective_state)
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

/**
 * Throws a 400 `WxycError` when both citations are non-null: the two are mutually exclusive, so the service refuses it as well as the controller.
 * A patch that changes the stored `cited_album_id` (a different release, null, or a submission cited instead) also takes off a review
 * accepted through that citation (`RELEASE_ACCEPTED_REVIEW`, decision 34): one that is not the item's own, found by reading the review row
 * unlocked (a review's `intake_item_id` never changes). Decided on the value the patch leaves, not on the key it carries.
 */
export const buildIntakePatch = (id: number, patch: Partial<IntakeFields> & IntakeCitations) => {
  if (patch.cited_album_id != null && patch.cited_submission_id != null) {
    throw new WxycError('cited_album_id and cited_submission_id cannot both be set', 400);
  }
  const leaves = patch.cited_submission_id != null ? null : patch.cited_album_id; // `undefined`: the stored value stays
  const citationChanged =
    leaves === undefined
      ? undefined
      : leaves === null
        ? sql`${intake_items.cited_album_id} IS NOT NULL`
        : sql`${intake_items.cited_album_id} IS DISTINCT FROM ${leaves}`;
  const takesOffReview = citationChanged
    ? sql`${citationChanged} AND EXISTS (SELECT 1 FROM ${reviews} WHERE ${reviews.id} = ${intake_items.accepted_review_id} AND ${reviews.intake_item_id} IS DISTINCT FROM ${intake_items.id})`
    : undefined;
  const unlessKept = (column: SQL, cleared: SQL) => sql`CASE WHEN ${takesOffReview} THEN ${cleared} ELSE ${column} END`;
  return db
    .update(intake_items)
    .set({
      ...patch,
      ...(takesOffReview && {
        accepted_review_id: unlessKept(sql`${intake_items.accepted_review_id}`, sql`NULL`),
        accepted_by: unlessKept(sql`${intake_items.accepted_by}`, sql`NULL`),
        accepted_at: unlessKept(sql`${intake_items.accepted_at}`, sql`NULL`),
        state: unlessKept(sql`${intake_items.state}`, RELEASED_STATE),
      }),
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

/**
 * The `SET` that takes an accepted review off an item: the three accept columns cleared together (never left to the
 * foreign key's `SET NULL`, which would let `accepted_by` and `accepted_at` outlive the pointer), and a `reviewed`
 * item sent back to its checkout (`checked_out`, when `checked_out_at` is set, even if the holder's account is gone, which a
 * music director may still return) or the pile (`pool`). Any other state is kept: a filed or finalized
 * item only loses the pointer. Flat `CASE`, not nested: two bare literals nested resolve to `text`, which cannot
 * meet the enum column.
 */
const RELEASED_STATE = sql`CASE WHEN ${intake_items.state} = 'reviewed' AND ${intake_items.checked_out_at} IS NOT NULL THEN 'checked_out' WHEN ${intake_items.state} = 'reviewed' THEN 'pool' ELSE ${intake_items.state} END`;
export const RELEASE_ACCEPTED_REVIEW: PgUpdateSetSource<typeof intake_items> = {
  accepted_review_id: null,
  accepted_by: null,
  accepted_at: null,
  state: RELEASED_STATE,
};

/**
 * Deletes an unfiled item and its reviews and passes (cascade), answering `authors`: the author of every review
 * the cascade took, drafts included. The item row is locked first, then its authors are read and the item deleted
 * in the same transaction, so a review created in between is either named or refused its subject.
 */
export const deleteIntakeItem = async (id: number) =>
  db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ state: intake_items.state })
      .from(intake_items)
      .where(eq(intake_items.id, id))
      .for('update');
    if (!locked) return { outcome: 'not_found' as const };
    if (FILED_STATES.includes(locked.state)) return { outcome: 'already_filed' as const };
    const [{ authors }] = await tx
      .select({ authors: reviewAuthorsSql() })
      .from(intake_items)
      .where(eq(intake_items.id, id));
    await tx.delete(intake_items).where(eq(intake_items.id, id));
    return { outcome: 'deleted' as const, authors };
  });

export type IntakeAction = 'checkout' | 'release' | 'request' | 'cancel_request' | 'accept' | 'pass';

const CLEAR_REQUEST = { requested_dj_id: null, requested_at: null };
const TAKEN = (actor: ReviewsActor) => ({
  state: 'checked_out' as const,
  ...CLEAR_REQUEST,
  checked_out_by: actor.id,
  checked_out_at: sql`now()`,
});
const TO_POOL = { state: 'pool' as const, ...CLEAR_REQUEST };

/**
 * `from` lists the EFFECTIVE states the action works from. `only` is the identity condition, which goes
 * in the UPDATE's WHERE: authorizing against a prior read would let A's release
 * match B's checkout taken in between. `release` also returns a `reviewed` item that still has a checkout
 * (`checked_out_at` set, holder's account or not), leaving it `reviewed`: the state falls to `pool` only from `checked_out`.
 */
const TRANSITIONS: Record<
  IntakeAction,
  {
    from: IntakeItemState[];
    set: (actor: ReviewsActor, djId?: string) => PgUpdateSetSource<typeof intake_items>;
    only?: (actor: ReviewsActor) => SQL | undefined;
    also?: SQL;
  }
> = {
  checkout: { from: ['pool'], set: TAKEN },
  release: {
    from: ['checked_out', 'reviewed'],
    set: () => ({
      state: sql`CASE WHEN ${intake_items.state} = 'checked_out' THEN 'pool' ELSE ${intake_items.state} END`,
      checked_out_by: null,
      checked_out_at: null,
    }),
    only: (actor) => (actor.manage ? undefined : eq(intake_items.checked_out_by, actor.id)),
    also: sql`(${intake_items.state} <> 'reviewed' OR ${intake_items.checked_out_at} IS NOT NULL)`,
  },
  request: {
    from: ['pool'],
    set: (_, djId) => ({ state: 'requested', requested_dj_id: djId, requested_at: sql`now()` }),
  },
  cancel_request: { from: ['requested'], set: () => TO_POOL },
  accept: { from: ['requested'], set: TAKEN, only: (actor) => eq(intake_items.requested_dj_id, actor.id) },
  pass: { from: ['requested'], set: () => TO_POOL, only: (actor) => eq(intake_items.requested_dj_id, actor.id) },
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
    .where(
      and(
        eq(intake_items.id, id),
        sql`(${effectiveState}) IN (${sql.join(
          t.from.map((state) => sql`${state}`),
          sql`, `
        )})`,
        t.only?.(actor),
        t.also
      )
    )
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

/**
 * The accept's one write, for a caller that already holds the item (and the review) locked in the order `acceptReview` uses and has
 * checked that the review belongs to the record: the review becomes the item's accepted one, an unfiled item becomes `reviewed`
 * (a filed or finalized one keeps its state), and a pending request is withdrawn. The holder is untouched.
 */
export const writeAcceptance = (
  tx: Pick<typeof db, 'update'>,
  itemId: number,
  reviewId: number,
  actor: Pick<ReviewsActor, 'id'>
) =>
  tx
    .update(intake_items)
    .set({
      accepted_review_id: reviewId,
      accepted_by: actor.id,
      accepted_at: sql`now()`,
      state: sql`CASE WHEN ${intake_items.state} IN ('filed', 'finalized') THEN ${intake_items.state} ELSE 'reviewed' END`,
      ...CLEAR_REQUEST,
    })
    .where(eq(intake_items.id, itemId));

/**
 * Accepts one submitted review for an item (BS#2860), in the order every item/review operation uses: the cited
 * release's `library` row `FOR SHARE` (only for an accept through the citation, so `DELETE /library/{id}`, which holds
 * that row `FOR UPDATE` and copies the cited cover reviews it finds, either follows this accept and copies its review or
 * is waited out and then finds the review gone), then the item `FOR UPDATE`, then the review with a plain
 * `SELECT ... FOR UPDATE` (never `.for('update', { of })`), then the checks, then one write. The review belongs to
 * the record when it is the item's own, a review of the release the item was filed as, or, for a cited item, a
 * submitted typed review of the cited release (a handwritten one is on another copy's sleeve). Both release arms compare
 * on a non-null id: two NULL `album_id`s must never match. A missing review, a draft and another record's review
 * answer one `bad_review`, so a draft's existence is not revealed. Every effective state has an answer, so there is no
 * conflict outcome: the item becomes `reviewed` unless filed or finalized, which only swap the pointer; a pending
 * request is withdrawn; the holder is untouched.
 */
export const acceptReview = async (id: number, reviewId: number, actor: ReviewsActor) => {
  const outcome = await db.transaction(async (tx) => {
    // The release to lock is read before any lock; the citation arm is only honored for the one locked.
    const [cites] = await tx
      .select({ cited: intake_items.cited_album_id })
      .from(intake_items)
      .where(eq(intake_items.id, id));
    if (!cites) return 'not_found' as const;
    const [peek] = await tx.select({ album: reviews.album_id }).from(reviews).where(eq(reviews.id, reviewId));
    const citedLocked = cites.cited !== null && peek?.album === cites.cited ? cites.cited : null;
    if (citedLocked !== null)
      await tx.select({ id: library.id }).from(library).where(eq(library.id, citedLocked)).for('share');
    const [item] = await tx
      .select({ album_id: intake_items.album_id, cited: intake_items.cited_album_id })
      .from(intake_items)
      .where(eq(intake_items.id, id))
      .for('update');
    if (!item) return 'not_found' as const;
    const [review] = await tx
      .select({ status: reviews.status, medium: reviews.medium, item: reviews.intake_item_id, album: reviews.album_id })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .for('update');
    const belongs =
      review !== undefined &&
      (review.item === id ||
        (item.album_id !== null && review.album === item.album_id) ||
        (citedLocked !== null &&
          item.cited === citedLocked &&
          review.album === citedLocked &&
          review.medium === 'typed'));
    if (!belongs || review.status !== 'submitted') return 'bad_review' as const;
    await writeAcceptance(tx, id, reviewId, actor);
    return 'accepted' as const;
  });
  return outcome === 'accepted' ? { outcome, item: (await getIntakeItem(id, true))! } : { outcome };
};

/** Where `POST /intake/{id}/file` files the item: onto a release it creates (planned by `planLibraryFiling`) or one that exists. */
export type IntakeFileArm =
  { kind: 'new_release'; input: ValidatedFilingInput } | { kind: 'existing_release'; album_id: number };

/** The release a filed or finalized item carries; any other item has none to lock or stamp. */
const filedRelease = (item: { album_id: number | null; state: string }) =>
  FILED_STATES.some((state) => state === item.state) ? item.album_id : null;

/**
 * Locks what a write is about and answers the columns that name it, or `undefined` when there is no such
 * subject (a deleted release, an item filed to another release in between). The lock order is the one
 * `DELETE /library/{id}` takes (BS#2928): the library row, then the item, then any review. A release subject
 * locks its library row. An item is held in any state: a FILED one carries its release, whose library row is
 * locked first from an unlocked read of the item, and the item second (`FOR UPDATE` when `itemMode` is
 * `'update'`, which the caller writes; `FOR SHARE` otherwise), whose release must be the one already locked.
 * A caller that gets `undefined` for an item that exists is in the case where filing committed between the read
 * and the lock; `withLockedRecordSubject` is the form that retries it.
 */
export const lockRecordSubject = async (
  tx: Pick<typeof db, 'select'>,
  subject: RecordSubject,
  itemMode: 'share' | 'update'
) => {
  if (!(subject.intake_item_id !== undefined)) {
    return (await lockReleaseRow(tx, subject.album_id)) ? { album_id: subject.album_id } : undefined;
  }
  const columns = { album_id: intake_items.album_id, state: intake_items.state };
  const where = eq(intake_items.id, subject.intake_item_id);
  const [peek] = await tx.select(columns).from(intake_items).where(where);
  if (!peek) return undefined;
  const release = filedRelease(peek);
  if (release !== null && !(await lockReleaseRow(tx, release))) return undefined;
  const [item] = await tx.select(columns).from(intake_items).where(where).for(itemMode);
  if (!item || filedRelease(item) !== release) return undefined;
  return { intake_item_id: subject.intake_item_id, album_id: release };
};

/**
 * Runs `body(tx, target)` in a transaction after `lockRecordSubject`, and answers `{ value }` (what `body` returned,
 * even `undefined`) or `undefined` when the subject is not there. An item the lock misses may have been filed between
 * its unlocked read and the lock; that attempt wrote nothing, filing is terminal and the retry locks the release first,
 * so an item subject runs the transaction once more. A release subject's miss, and a second miss, answer `undefined`.
 */
export const withLockedRecordSubject = async <T>(
  subject: RecordSubject,
  itemMode: 'share' | 'update',
  body: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    target: NonNullable<Awaited<ReturnType<typeof lockRecordSubject>>>
  ) => Promise<T>
) => {
  for (let attempt = subject.intake_item_id !== undefined ? 2 : 1; attempt > 0; attempt--) {
    const result = await db.transaction(async (tx) => {
      const target = await lockRecordSubject(tx, subject, itemMode);
      return target ? { value: await body(tx, target) } : undefined;
    });
    if (result) return result;
  }
  return undefined;
};

/**
 * Files an item (BS#2803) in one transaction, in the order `DELETE /library/{id}` (BS#2928) takes its locks: an existing
 * release's `library` row `FOR KEY SHARE` (that locked read is the existence check, so a release deleted in between
 * is `unknown_album`, never a foreign-key 500), then the item `FOR UPDATE`, then, through the stamping UPDATEs, the
 * review and print rows. The new-release arm has no row to lock first; `fileLibraryRelease` runs on the same `tx`
 * after the item lock and the checks. Filing keeps the accept columns, clears the holder and the request, stamps
 * `album_id` on EVERY review, print and FCC note of the item (drafts included, the delete snapshot reaches them through it) and
 * drops the item's passes. `filing_conflict` is `mapLibraryFilingError`'s 409; the caller finishes a new release with
 * `completeLibraryFiling(filed, input)` after the commit.
 */
export const fileIntakeItem = async (id: number, arm: IntakeFileArm, filedBy: string) => {
  try {
    const outcome = await db.transaction(async (tx) => {
      if (arm.kind === 'existing_release') {
        if (!(await lockReleaseRow(tx, arm.album_id))) return { outcome: 'unknown_album' as const };
      }
      const [item] = await tx
        .select({ state: intake_items.state, accepted_review_id: intake_items.accepted_review_id })
        .from(intake_items)
        .where(eq(intake_items.id, id))
        .for('update');
      if (!item) return { outcome: 'not_found' as const };
      if (FILED_STATES.includes(item.state)) return { outcome: 'state_changed' as const };
      if (!mayFileItem(item)) return { outcome: 'not_reviewed' as const };
      let filed: Awaited<ReturnType<typeof fileLibraryRelease>> | undefined;
      let albumId: number;
      if (arm.kind === 'new_release') {
        filed = await fileLibraryRelease(arm.input, { kind: 'intake', intakeItemId: id }, tx);
        albumId = filed.release.id;
      } else {
        albumId = arm.album_id;
      }
      await tx
        .update(intake_items)
        .set({
          state: 'filed',
          album_id: albumId,
          rotation_id: filed?.rotation?.id ?? null,
          filed_by: filedBy,
          filed_at: sql`now()`,
          checked_out_by: null,
          checked_out_at: null,
          ...CLEAR_REQUEST,
        })
        .where(eq(intake_items.id, id));
      await tx.update(reviews).set({ album_id: albumId }).where(eq(reviews.intake_item_id, id));
      await tx.update(review_prints).set({ album_id: albumId }).where(eq(review_prints.intake_item_id, id));
      await tx.update(fcc_notes).set({ album_id: albumId }).where(eq(fcc_notes.intake_item_id, id));
      await tx.delete(intake_item_passes).where(eq(intake_item_passes.intake_item_id, id));
      return { outcome: 'filed' as const, filed };
    });
    if (outcome.outcome !== 'filed') return outcome;
    return { outcome: 'filed' as const, filed: outcome.filed, item: (await getIntakeItem(id, true))! };
  } catch (error) {
    return { outcome: 'filing_conflict' as const, body: mapLibraryFilingError(error) };
  }
};

/**
 * Finalizes a filed item (BS#2804): `filed` to `finalized`, stamping the caller. The item is locked `FOR UPDATE` and its
 * state read under the lock, so a second finalize is `state_changed`. A release still in rotation is refused as
 * `in_rotation`, found by the item's `album_id` through `rotationActiveSql()`, the one active predicate every rotation list
 * uses, never by `intake_items.rotation_id` (`SET NULL` when the call-number dedup deletes a loser's row, and never set by
 * the `existing_release` arm). The message names the latest kill date, or says none is set. Changes nothing in `library`.
 */
export const finalizeIntakeItem = async (id: number, finalizedBy: string) => {
  const outcome = await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ state: intake_items.state, album_id: intake_items.album_id })
      .from(intake_items)
      .where(eq(intake_items.id, id))
      .for('update');
    if (!item) return { outcome: 'not_found' as const };
    if (item.state !== 'filed') return { outcome: 'state_changed' as const };
    const active = await tx
      .select({ kill_date: rotation.kill_date })
      .from(rotation)
      .where(and(eq(rotation.album_id, item.album_id!), rotationActiveSql()));
    if (active.length > 0) {
      const dates = active.map((row) => row.kill_date);
      const latest = dates.includes(null) ? null : dates.sort().at(-1);
      const until = latest ? `until ${latest}` : 'and no kill date is set';
      return { outcome: 'in_rotation' as const, message: `The release is still in rotation ${until}` };
    }
    await tx
      .update(intake_items)
      .set({ state: 'finalized', finalized_by: finalizedBy, finalized_at: sql`now()` })
      .where(eq(intake_items.id, id));
    return { outcome: 'finalized' as const };
  });
  // Without the manager-only columns: the caller holds `catalog: write`, not necessarily `reviews: manage`.
  return outcome.outcome === 'finalized' ? { ...outcome, item: (await getIntakeItem(id, false))! } : outcome;
};

/** The `auth_member` roles of an account — empty when the account is unknown or has no membership. */
export const memberRoles = async (userId: string) =>
  (await db.select({ role: member.role }).from(member).where(eq(member.userId, userId))).map((r) => r.role);
