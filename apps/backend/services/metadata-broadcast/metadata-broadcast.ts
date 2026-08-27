/**
 * Bridges the enrichment consumer's terminal UPDATE → SSE `liveFs:update`
 * broadcast (BS#892 / PR-2; closes BS#893, BS#628).
 *
 * The enrichment-worker is a separate process — it can't call
 * `serverEventsMgr.broadcast()` directly. Rather than add HTTP/IPC between
 * the two, this hook subscribes to the same CDC stream the worker writes
 * into. PG's per-process LISTEN means every BS instance receives the
 * UPDATE NOTIFY; each instance broadcasts only to its own SSE clients
 * (each client is connected to exactly one BS instance), so there's no
 * duplication.
 *
 * Filter criteria (all must hold):
 *   - table === 'flowsheet'
 *   - action === 'UPDATE'
 *   - data.metadata_status is a terminal state
 *     ('enriched_match' | 'enriched_no_match' | 'failed_no_retry')
 *
 * Payload is the flowsheet row from `event.data`, projected through the
 * client-facing `CLIENT_FACING_FLOWSHEET_COLUMNS` allow-list (BS-2 inlined
 * the row; BS#1534 projects it). dj-site's listener middleware patches the
 * row into its RTK Query cache directly — a /live viewer that just opened
 * the page sees post-enrichment fields (`artwork_url`, `release_year`, etc.)
 * without a follow-up GET. The `/events/stream` topic is anonymous
 * (`Topics.liveFs` authz `[]`), so the projection keeps the raw CDC row's
 * internal columns (`search_doc`, `composer`, `legacy_*`, `linkage_*`, …)
 * off the public stream — the same allow-list the mutation echoes and DJ
 * peek use (BS#1513). `wxyc-shared`'s `LiveFsUpdateEvent` is the canonical
 * cross-language shape; this file's `LiveFsUpdatePayload` mirrors that
 * contract. (The `/cdc` WebSocket fan-out stays unprojected by design — it
 * is `CDC_SECRET`-gated and its reconciliation-monitor consumer needs the
 * complete row; see `docs/cdc.md`.)
 *
 * False positives: the filter matches any flowsheet UPDATE that lands in
 * a terminal metadata_status. The historical `flowsheet-metadata-backfill`
 * also writes terminal status (via #891's seed), but it runs nightly and
 * the broadcasts during that window are exactly the signal listeners
 * already need ("a backfill enriched this row, refetch").
 *
 * Idempotency: SSE clients tolerate duplicate `update` events naturally —
 * the worst case is an extra refetch. The CDC pipeline does not dedupe
 * across BS instances, but each instance only owns its own SSE clients,
 * so there's no per-client duplication.
 */

import * as Sentry from '@sentry/node';
import type { CdcEvent } from '@wxyc/database';
import { onCdcEvent } from '@wxyc/database';
import type { LiveFsInsertEvent } from '@wxyc/shared/dtos';
import { serverEventsMgr, Topics, FsEvents } from '../../utils/serverEvents.js';
import { pickClientFacingColumns, toDiscogsUnavailableWireFields } from '../../utils/flowsheet-projection.js';
import { getCachedDiscogsUnavailableFlags, invalidateDiscogsUnavailableFlags } from './discogs-unavailable-cache.js';
import { recordInsertSuppressed, recordUpdateSuppressed } from '../sse/sse-metrics.js';

const TERMINAL_STATUSES = new Set(['enriched_match', 'enriched_no_match', 'failed_no_retry']);

const LOG_PREFIX = '[metadata-broadcast]';

/**
 * Default `liveFs:insert` age-guard threshold (BS#2131, parent #2118 site 4):
 * a track INSERT whose `add_time` is older than this is treated as a
 * historical/bulk-import row rather than a live play, and is not broadcast.
 * Overridable via `LIVE_FS_INSERT_MAX_AGE_HOURS` — see `docs/env-vars.md`.
 */
const LIVE_FS_INSERT_MAX_AGE_HOURS_DEFAULT = 24;

/**
 * Warn-once latch for `resolveLiveFsInsertMaxAgeMs`, keyed on the raw env-var
 * string rather than a boolean. The resolver runs once per flowsheet INSERT
 * callback — during exactly the bulk import this feature targets, a
 * persistently-misconfigured env var would otherwise log one warning per row.
 * Keying on the raw string (not just "have we ever warned") means a mid-run
 * env change to a DIFFERENT bad value still gets its own warning, rather than
 * going silent because *something* was already warned about once.
 */
let lastWarnedRawLiveFsInsertMaxAge: string | undefined;

/**
 * Default `liveFs:update` age-guard threshold (BS#2281 prerequisite). Same
 * 24h as the insert guard, but its OWN knob: the two paths have different
 * volume profiles, and an operator narrowing one during a bulk run should not
 * silently move the other.
 */
const LIVE_FS_UPDATE_MAX_AGE_HOURS_DEFAULT = 24;

/** Warn-once latch for `resolveLiveFsUpdateMaxAgeMs`. Same rationale as above. */
let lastWarnedRawLiveFsUpdateMaxAge: string | undefined;

/**
 * Shared parse-and-warn body behind both age-guard resolvers.
 *
 * Extracted rather than copied when the update path gained its own threshold:
 * the `0`-is-rejected rule below is the load-bearing part, and two hand-kept
 * copies of it is precisely how one path ends up quietly accepting `0` as
 * "disabled" and taking a live feed dark.
 */
function parseMaxAgeMs(
  raw: string | undefined,
  envName: string,
  defaultHours: number,
  readLatch: () => string | undefined,
  writeLatch: (value: string) => void
): number {
  const defaultMs = defaultHours * 60 * 60 * 1000;
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const parsedHours = Number(raw);
  if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
    if (readLatch() !== raw) {
      console.warn(
        `${LOG_PREFIX} invalid ${envName}=${JSON.stringify(raw)} (must be a positive number of hours; 0 is rejected, not "disabled" — see docs/env-vars.md); using default ${defaultHours}`
      );
      writeLatch(raw);
    }
    return defaultMs;
  }
  return parsedHours * 60 * 60 * 1000;
}

/**
 * Resolves the `liveFs:update` age-guard threshold in milliseconds.
 *
 * Same warn-and-default-never-throw posture as the insert resolver, and the
 * same rejection of `0`: `isOlderThanThreshold` compares `nowMs - addTimeMs >
 * thresholdMs`, which is positive for every real row, so a `0` threshold
 * would classify every update as historical and take the whole
 * `liveFs:update` feed dark station-wide.
 */
export function resolveLiveFsUpdateMaxAgeMs(
  raw: string | undefined = process.env.LIVE_FS_UPDATE_MAX_AGE_HOURS
): number {
  return parseMaxAgeMs(
    raw,
    'LIVE_FS_UPDATE_MAX_AGE_HOURS',
    LIVE_FS_UPDATE_MAX_AGE_HOURS_DEFAULT,
    () => lastWarnedRawLiveFsUpdateMaxAge,
    (value) => {
      lastWarnedRawLiveFsUpdateMaxAge = value;
    }
  );
}

/** Test hook: clear the update-path warn-once latch. Sibling of the insert one. */
export function __resetLiveFsUpdateMaxAgeWarnLatchForTests(): void {
  lastWarnedRawLiveFsUpdateMaxAge = undefined;
}

/**
 * Resolves the `liveFs:insert` age-guard threshold in milliseconds.
 * Warn-and-default on misconfig (never throw): this runs on every flowsheet
 * INSERT's CDC callback, so a bad env var must degrade to the safe default
 * rather than take down the broadcast path for every live play.
 *
 * `0` is rejected alongside negative and non-numeric values — it is NOT
 * "disable the guard." `isOlderThanThreshold` evaluates `nowMs -
 * parsedAddTimeMs > thresholdMs`; that difference is positive for every real
 * insert (the row is always at least a few milliseconds old by the time this
 * callback runs), so a `0` threshold classifies every live play as
 * historical and silently takes the whole `liveFs:insert` feed dark
 * station-wide — the exact inverse of what an operator reaching for `0` as
 * "no ceiling" would expect. Same hazard, same handling as
 * `DIGEST_MAX_PLAY_AGE_HOURS`'s `requirePositiveInt` (see `docs/env-vars.md`).
 */
export function resolveLiveFsInsertMaxAgeMs(
  raw: string | undefined = process.env.LIVE_FS_INSERT_MAX_AGE_HOURS
): number {
  return parseMaxAgeMs(
    raw,
    'LIVE_FS_INSERT_MAX_AGE_HOURS',
    LIVE_FS_INSERT_MAX_AGE_HOURS_DEFAULT,
    () => lastWarnedRawLiveFsInsertMaxAge,
    (value) => {
      lastWarnedRawLiveFsInsertMaxAge = value;
    }
  );
}

/**
 * Test hook: clear the warn-once latch. Only consumed by
 * tests/unit/apps/backend/services/metadata-broadcast.test.ts, so tests that
 * exercise the same invalid raw value (e.g. `'0'`) from different describe
 * blocks don't see each other's latched state — mirrors the
 * `__resetForTests` convention in `../sse/sse-metrics.ts`.
 */
export function __resetLiveFsInsertMaxAgeWarnLatchForTests(): void {
  lastWarnedRawLiveFsInsertMaxAge = undefined;
}

/**
 * Parses `rawAddTime` to epoch milliseconds, or `null` when it isn't a
 * parseable string. `to_jsonb(NEW)` always ships `add_time` as an
 * offset-bearing ISO string in production (the column is `.notNull()`), so a
 * non-string or unparseable value here only happens in a test fixture or a
 * schema-drift edge case. Callers treat `null` as "fail open" (not
 * historical) — never a reason to silently drop a live insert.
 */
function parseAddTimeMs(rawAddTime: unknown): number | null {
  if (typeof rawAddTime !== 'string') return null;
  const parsedMs = Date.parse(rawAddTime);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

/**
 * True when an already-parsed `add_time` (epoch ms) is older than the
 * age-guard threshold relative to `nowMs`. Split out from `parseAddTimeMs` so
 * callers only pay for `resolveLiveFsInsertMaxAgeMs()`'s env read when there
 * is a parseable value to compare against — a marker row or a fixture
 * without `add_time` never reaches this function.
 */
function isOlderThanThreshold(parsedAddTimeMs: number, nowMs: number, thresholdMs: number): boolean {
  return nowMs - parsedAddTimeMs > thresholdMs;
}

/**
 * The instant to compare `add_time` against: `CdcEvent.timestamp`, populated
 * by `(extract(epoch from clock_timestamp()) * 1000)::bigint` in the SAME
 * trigger invocation that produced `to_jsonb(NEW)` — the same database clock
 * `add_time` itself came from, at essentially the same instant. Deliberately
 * NOT `Date.now()`: that would compare a database-clock `add_time` against
 * an app-server clock, a needless cross-clock comparison that's harmless at
 * a 24h threshold but not harmless under the narrow-the-threshold mitigation
 * this file's `filterMetadataInsert` docstring recommends for the
 * recent-re-import residual. Falls back to `Date.now()` only because
 * `cdc-listener.ts`'s `onCdcEvent` dispatch does a bare `JSON.parse(payload)
 * as CdcEvent` with no runtime validation, so `timestamp` isn't guaranteed
 * present or numeric.
 */
function resolveEventNowMs(event: CdcEvent): number {
  return typeof event.timestamp === 'number' ? event.timestamp : Date.now();
}

type TrackInsertMatch = { data: Record<string, unknown>; id: number };

/**
 * Structural match for a flowsheet track INSERT — `table`/`action`/`data`
 * present/`entry_type === 'track'`/numeric `id` — WITHOUT the add_time age
 * guard. Shared by `filterMetadataInsert` and `isAgeSuppressedInsert` so the
 * two can never disagree about what counts as "a track insert" the age guard
 * applies to.
 */
function matchTrackInsert(event: CdcEvent): TrackInsertMatch | null {
  if (event.table !== 'flowsheet') return null;
  if (event.action !== 'INSERT') return null;
  if (!event.data) return null;

  const data = event.data as Record<string, unknown>;
  if (data.entry_type !== 'track') return null;

  const id = data.id;
  if (typeof id !== 'number') return null;

  return { data, id };
}

/**
 * Wire shape of the `liveFs:update` payload. Mirrors `LiveFsUpdateEvent` in
 * `wxyc-shared/api.yaml`. The two required fields (`id`, `metadata_status`)
 * are pinned because we assert them at the filter boundary; the remaining
 * columns are the `CLIENT_FACING_FLOWSHEET_COLUMNS` allow-list subset
 * (`artist_name`, `album_title`, `artwork_url`, ...) that `pickClientFacingColumns`
 * projects (BS#1534) — dj-site / iOS receive them via the typed
 * `FlowsheetSongEntry` schema generated from `@wxyc/shared`, which is the
 * cross-language source of truth.
 */
export type LiveFsUpdatePayload = {
  id: number;
  metadata_status: 'enriched_match' | 'enriched_no_match' | 'failed_no_retry';
  [key: string]: unknown;
};

type TerminalTrackUpdateMatch = { data: Record<string, unknown>; id: number; status: string };

/**
 * Structural match for a terminal-status flowsheet track UPDATE — WITHOUT the
 * add_time age guard. Shared by `filterMetadataUpdate` and
 * `isAgeSuppressedUpdate` so the two can never disagree about what counts as
 * "an update the age guard applies to", exactly as `matchTrackInsert` does for
 * the insert path.
 *
 * The `entry_type === 'track'` check is new with the age guard (BS#2281
 * prerequisite) and is a no-op today: every enrichment writer already gates on
 * `entry_type = 'track'`, and `metadata_status` defaults to `'pending'` for
 * marker rows, so no non-track row reaches a terminal status. It exists so a
 * future writer that does cannot start pushing marker rows onto a stream whose
 * payload is typed as a track row and which dj-site patches into a track
 * cache — and so the two filters stay symmetric.
 */
function matchTerminalTrackUpdate(event: CdcEvent): TerminalTrackUpdateMatch | null {
  if (event.table !== 'flowsheet') return null;
  if (event.action !== 'UPDATE') return null;
  if (!event.data) return null;

  const data = event.data as Record<string, unknown>;
  if (data.entry_type !== undefined && data.entry_type !== 'track') return null;

  const status = data.metadata_status;
  if (typeof status !== 'string' || !TERMINAL_STATUSES.has(status)) return null;

  const id = data.id;
  if (typeof id !== 'number') return null;

  return { data, id, status };
}

/**
 * Pure filter for testability — returns the broadcast payload on match, null
 * on skip.
 *
 * `add_time` age guard (BS#2281 prerequisite, mirroring BS#2131's insert
 * guard). Without it this filter broadcasts on ANY flowsheet UPDATE landing
 * in a terminal `metadata_status`, and historical `track` rows are almost all
 * terminal — so any bulk UPDATE over the table emits one projected
 * `liveFs:update` per row to every `/events/stream` client on every backend
 * instance, for the entire run. `jobs/flowsheet-dj-name-scrub` (BS#2281) is a
 * multi-hour drain over ~2.6M rows; without this guard it would push millions
 * of unsolicited events at live connections. `jobs/flowsheet-metadata-backfill`
 * has been paying a smaller nightly version of the same cost.
 *
 * What that costs: an enrichment landing on a row older than
 * `LIVE_FS_UPDATE_MAX_AGE_HOURS` (default 24h) no longer emits its "refetch
 * me" signal. That is a deliberate narrowing of the behaviour this
 * docstring's "False positives" note previously described as desirable — a
 * client viewing a historical range loses a live patch it would otherwise
 * have received and must refetch on its own. Enrichment of anything played in
 * the last day, which is the case that actually matters to a `/live` viewer,
 * is unaffected.
 *
 * Fails OPEN on a missing or unparseable `add_time`, same as the insert path
 * (see `parseAddTimeMs`): never silently drop a live update over an
 * unreadable timestamp. Age is measured against `CdcEvent.timestamp` (the
 * database clock that produced `add_time`), not `Date.now()` — see
 * `resolveEventNowMs`.
 */
export function filterMetadataUpdate(event: CdcEvent): LiveFsUpdatePayload | null {
  const match = matchTerminalTrackUpdate(event);
  if (!match) return null;

  const parsedAddTimeMs = parseAddTimeMs(match.data.add_time);
  if (
    parsedAddTimeMs !== null &&
    isOlderThanThreshold(parsedAddTimeMs, resolveEventNowMs(event), resolveLiveFsUpdateMaxAgeMs())
  ) {
    return null;
  }

  // Project through the client-facing allow-list before the row hits the
  // anonymous `/events/stream` (BS#1534): internal CDC columns (`search_doc`,
  // `composer`, `legacy_*`, `linkage_*`, …) must not ride the public stream.
  return {
    ...pickClientFacingColumns(match.data),
    id: match.id,
    metadata_status: match.status as LiveFsUpdatePayload['metadata_status'],
  };
}

/**
 * True when `event` structurally matches a terminal-status flowsheet track
 * UPDATE but its `add_time` is older than the age-guard threshold — i.e.
 * exactly the branch inside `filterMetadataUpdate` that returns `null` for
 * that reason. Sibling of `isAgeSuppressedInsert`, and for the same reason:
 * it separates an intentional historical-row drop (worth a metric) from the
 * ordinary "this CDC event isn't a terminal track update at all" nulls that
 * make up the bulk of `onCdcEvent` traffic and would otherwise swamp the
 * counter with routing noise.
 */
export function isAgeSuppressedUpdate(event: CdcEvent): boolean {
  const match = matchTerminalTrackUpdate(event);
  if (!match) return false;

  const parsedAddTimeMs = parseAddTimeMs(match.data.add_time);
  if (parsedAddTimeMs === null) return false;

  return isOlderThanThreshold(parsedAddTimeMs, resolveEventNowMs(event), resolveLiveFsUpdateMaxAgeMs());
}

/**
 * Filter for the `liveFs:insert` broadcast (BS#1888) — returns the
 * client-facing row payload on a match, null on skip. Synchronous and
 * DB-free (no I/O), preserving the deliberate testability seam — but as of
 * the add_time age guard below, NOT a strict pure function of `event` alone:
 * `resolveLiveFsInsertMaxAgeMs()` reads `process.env.LIVE_FS_INSERT_MAX_AGE_HOURS`
 * as ambient config. Tests still control that deterministically by setting
 * the env var before the call; only genuine non-determinism (a DB read, wall
 * clock) is disallowed here — see `resolveEventNowMs`'s doc for why the
 * clock itself comes from `event.timestamp`, not `Date.now()`.
 *
 * Fires on a flowsheet INSERT of a `track` row: the Epic C ([#877]) "a new
 * track was played" event. The CDC trigger captures every insert source (a
 * dj-site/iOS `addEntry`, the flowsheet ETL, the auto-dj orchestrator), so a
 * subscriber appends the row live regardless of origin, no polling. The row is
 * `metadata_status: 'pending'` at insert; its enrichment fields arrive seconds
 * later as the existing `liveFs:update`. INSERT and UPDATE are distinct CDC
 * actions, so the two broadcasters never double-emit for one row.
 *
 * Scoped to `entry_type === 'track'`. Marker / message rows (`show_start`,
 * `dj_join`, breakpoints, talksets) are excluded: they aren't the "new track"
 * signal the iOS consumer ([wxyc-ios-64#269]) appends, and excluding them keeps
 * a bulk historical flowsheet import from flooding live subscribers with
 * non-track rows.
 *
 * `add_time` age guard (BS#2131, parent #2118 site 4): track rows are exactly
 * what a bulk historical/backfill import is mostly made of, and
 * `flowsheet.id` is not a chronological key — an import lands at the head of
 * the serial PK, not the head of the timeline (see #2118's six-site
 * analysis). A row whose `add_time` is older than `LIVE_FS_INSERT_MAX_AGE_HOURS`
 * (default 24h, `resolveLiveFsInsertMaxAgeMs`) is treated as historical and
 * does not broadcast; a normal live play (`add_time` recent) still does.
 * Fails OPEN on a missing or unparseable `add_time` — see `parseAddTimeMs`'s
 * doc — and parses defensively via `Number.isNaN(Date.parse(...))` rather
 * than pattern-matching the format, since `to_jsonb` renders a `timestamptz`
 * as an offset-bearing ISO string (e.g. `-04:00`), not a guaranteed `Z`
 * suffix. A suppressed insert is silent from this function's own
 * perspective (it stays a pure predicate) — `setupMetadataBroadcast` below
 * is the one that turns a suppression into a `SSE/InsertSuppressed`
 * CloudWatch signal via `isAgeSuppressedInsert`, so the drop is observable
 * without the filter itself taking on a side effect.
 *
 * **Residual the age guard does NOT cover**: a *recent* re-import — e.g. a
 * last-write tubafrenzy re-run (#1543) done hours after the plays it carries
 * actually aired — has an `add_time` inside the threshold window and still
 * broadcasts as if it were live. There is no purely local signal in this CDC
 * row that distinguishes "just played" from "just imported, but recently
 * aired," so the mitigation for that case is procedural, not code: run such
 * re-imports outside the live listening window, or narrow the threshold
 * (`LIVE_FS_INSERT_MAX_AGE_HOURS`) for the duration of the run — never `0`,
 * which is rejected (see `resolveLiveFsInsertMaxAgeMs`'s doc). See #2118's
 * "chronOrderID" discussion for the full shape of this residual.
 *
 * Same `CLIENT_FACING_FLOWSHEET_COLUMNS` projection as the update broadcast
 * (BS#1534) — internal CDC columns never ride the anonymous stream. The payload
 * is the generated `LiveFsInsertEvent['payload']` (`FlowsheetEntryResponse`)
 * from `@wxyc/shared` (#273), whose enrichment fields are nullable so a
 * pre-enrichment row is valid.
 */
export function filterMetadataInsert(event: CdcEvent): LiveFsInsertEvent['payload'] | null {
  const match = matchTrackInsert(event);
  if (!match) return null;

  const parsedAddTimeMs = parseAddTimeMs(match.data.add_time);
  if (
    parsedAddTimeMs !== null &&
    isOlderThanThreshold(parsedAddTimeMs, resolveEventNowMs(event), resolveLiveFsInsertMaxAgeMs())
  ) {
    return null;
  }

  return {
    ...pickClientFacingColumns(match.data),
    id: match.id,
  } as LiveFsInsertEvent['payload'];
}

/**
 * True when `event` structurally matches a flowsheet track INSERT (the same
 * match `filterMetadataInsert` requires, via the shared `matchTrackInsert`)
 * but its `add_time` is older than the age-guard threshold — i.e. exactly
 * the branch inside `filterMetadataInsert` that returns `null` for that
 * reason. Distinguishes an intentional historical-row drop (signal worth a
 * metric) from the ordinary "this CDC event isn't a track insert at all"
 * nulls (wrong table/action, non-track `entry_type`, missing `id`) that make
 * up the bulk of `onCdcEvent` traffic — the latter would swamp a naive
 * "count every null" metric with routing noise. Consumed by
 * `setupMetadataBroadcast` to drive the `SSE/InsertSuppressed` CloudWatch
 * counter; `filterMetadataInsert` itself stays free of side effects.
 */
export function isAgeSuppressedInsert(event: CdcEvent): boolean {
  const match = matchTrackInsert(event);
  if (!match) return false;

  const parsedAddTimeMs = parseAddTimeMs(match.data.add_time);
  if (parsedAddTimeMs === null) return false;

  return isOlderThanThreshold(parsedAddTimeMs, resolveEventNowMs(event), resolveLiveFsInsertMaxAgeMs());
}

/**
 * Register the metadata-broadcast CDC handler. Call once at startup, after
 * `serverEventsMgr` is ready. Sits alongside `setupCdcWebSocket()` — both
 * register independent `onCdcEvent` handlers against the per-process LISTEN
 * connection owned by `startCdcDispatcher()` (see
 * `apps/backend/services/cdc/dispatcher.ts`). The dispatcher runs whether
 * or not the websocket is configured (BS#1187), so this handler fires in
 * environments without `CDC_SECRET`.
 *
 * BS#1962: both handlers additionally enrich a library-linked payload with
 * `discogsUnavailable` / `discogsUnavailableNote` before broadcasting, for
 * parity with the paginated read path's `transformToV2` (#1908). The filters
 * (`filterMetadataUpdate` / `filterMetadataInsert`) stay synchronous and
 * DB-free — their "no DB" testability seam is load-bearing for the existing
 * filter unit tests — so the enrichment lives here, gated behind a non-null
 * `album_id`: a non-library row (`album_id === null`) takes the ORIGINAL
 * fully-synchronous path unchanged (the `await` on an already-resolved
 * value would still defer the broadcast to a later microtask and break the
 * "broadcast fired synchronously" assertions those fixtures pin). Only a
 * library-linked row pays the extra (cached, coalesced) read.
 *
 * BS#2131 review follow-up: the insert handler also records a
 * `SSE/InsertSuppressed` CloudWatch signal (`recordInsertSuppressed`, see
 * `../sse/sse-metrics.ts`) whenever `isAgeSuppressedInsert` says the age
 * guard dropped an otherwise-valid track insert. Counting lives here, not
 * inside `filterMetadataInsert`, so the filter itself stays a side-effect-free
 * predicate.
 *
 * The cache read is fire-and-forget from the CDC dispatcher's perspective:
 * `startCdcDispatcher` invokes every registered callback synchronously and
 * does not await them (`cdc-listener.ts`'s `cb(event)` inside a try that only
 * catches *synchronous* throws), so the `void (async () => {...})()` IIFE
 * below — whose own inner `try/catch` swallows every rejection — never
 * leaves a dangling unhandled rejection for the dispatcher to see.
 *
 * Ordering: `getCachedDiscogsUnavailableFlags` coalesces concurrent lookups
 * for the same `album_id` onto one in-flight promise (see
 * `discogs-unavailable-cache.ts`). A same-row `insert` (cold, slow read)
 * followed seconds later by its terminal `update` share that promise; both
 * `await` the identical object, and promise continuations resolve FIFO by
 * await-registration order, so `insert` still broadcasts before `update`.
 * Only cross-album_id ordering (a cold read for album A racing a warm hit
 * for album B) can reorder — benign, since SSE patches are per-`id` and
 * convergent on both dj-site and iOS.
 *
 * A third handler invalidates the discogs-unavailable cache on every `library`
 * UPDATE/DELETE. `library` is CDC-tracked (`cdc_library`, migration 0046), so a
 * `discogs_unavailable` flip NOTIFYs every BS instance's LISTEN connection —
 * driving invalidation from here (rather than the write path, which only runs
 * on the one instance that served the PATCH) drops the flipped album from every
 * instance's cache, so the fresh flag appears on the very next broadcast
 * regardless of which instance serves it. See `discogs-unavailable-cache.ts`.
 */
export function setupMetadataBroadcast(): void {
  const broadcastUpdate = (payload: LiveFsUpdatePayload): void => {
    try {
      serverEventsMgr.broadcast(Topics.liveFs, {
        type: FsEvents.update,
        payload,
      });
    } catch (err) {
      // Broadcast errors must not break the CDC handler chain. The
      // serverEventsMgr.broadcast already swallows per-client errors
      // (unsubAll on write failure); this guard catches anything else
      // (e.g. an empty topic set wouldn't throw, but a future change
      // might). Surface to Sentry so a sudden rate spike isn't invisible.
      Sentry.captureException(err, {
        tags: { module: 'metadata-broadcast', subsystem: 'sse' },
        extra: { id: payload.id, metadata_status: payload.metadata_status },
      });
    }
  };

  onCdcEvent((event) => {
    const payload = filterMetadataUpdate(event);
    if (!payload) {
      // Distinguish the intentional historical-row drop from the routing
      // nulls that make up most of this handler's traffic, so a bulk UPDATE's
      // suppression volume is observable in CloudWatch rather than invisible.
      // Mirrors the insert path's `SSE/InsertSuppressed` wiring below;
      // `filterMetadataUpdate` itself stays a side-effect-free predicate.
      if (isAgeSuppressedUpdate(event)) {
        recordUpdateSuppressed(Topics.liveFs);
      }
      return;
    }
    const albumId = typeof payload.album_id === 'number' ? payload.album_id : null;
    if (albumId === null) {
      broadcastUpdate(payload);
      return;
    }
    void (async () => {
      try {
        const flags = await getCachedDiscogsUnavailableFlags(albumId);
        Object.assign(payload, toDiscogsUnavailableWireFields(flags));
      } catch {
        // Additive-failure (BS#1962): a DB blip on the enrichment read must
        // never suppress the broadcast — omit the fields and send the
        // pre-#1962 payload shape. Deliberately swallowed here (not
        // rethrown) so it can never trip the broadcast-level Sentry capture
        // in broadcastUpdate, which stays scoped to genuine broadcast
        // failures.
      }
      broadcastUpdate(payload);
    })();
  });

  const broadcastInsert = (payload: LiveFsInsertEvent['payload']): void => {
    try {
      serverEventsMgr.broadcast(Topics.liveFs, {
        type: FsEvents.insert,
        payload,
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { module: 'metadata-broadcast', subsystem: 'sse' },
        extra: { id: payload.id },
      });
    }
  };

  // BS#1888: broadcast `liveFs:insert` the instant a track row is created,
  // before enrichment. A separate `onCdcEvent` registration (INSERT vs the
  // update handler's UPDATE) so the two never double-emit for one row — a track
  // fires `insert` on creation, then `update` when its metadata_status reaches a
  // terminal state. Same per-process LISTEN + own-clients-only fan-out.
  onCdcEvent((event) => {
    const payload = filterMetadataInsert(event);
    if (!payload) {
      // BS#2131 review follow-up: distinguish "the age guard intentionally
      // dropped a historical track insert" (signal) from every other reason
      // filterMetadataInsert returned null (an unrelated CDC event — most of
      // onCdcEvent's traffic). Only the former increments the metric.
      if (isAgeSuppressedInsert(event)) {
        recordInsertSuppressed(Topics.liveFs);
      }
      return;
    }
    const albumId = typeof payload.album_id === 'number' ? payload.album_id : null;
    if (albumId === null) {
      broadcastInsert(payload);
      return;
    }
    void (async () => {
      try {
        const flags = await getCachedDiscogsUnavailableFlags(albumId);
        Object.assign(payload, toDiscogsUnavailableWireFields(flags));
      } catch {
        // Additive-failure — see the update handler's comment above.
      }
      broadcastInsert(payload);
    })();
  });

  // BS#1962: invalidate the discogs-unavailable cache off the same CDC stream.
  // `library` is CDC-tracked (`cdc_library`, migration 0046), so a
  // `discogs_unavailable` flip — an MD's PATCH /library/{id}, or the recheck
  // cron — NOTIFYs every BS instance's LISTEN connection; dropping the cached
  // flag on every instance here (not just the one that served the write) means
  // the fresh flag rides the very next broadcast on whichever instance serves
  // it. Purely synchronous — no broadcast, so no ordering interaction with the
  // two enrich handlers above. Scoped to UPDATE/DELETE: a fresh INSERT gets a
  // new serial id no flowsheet row can FK yet, so it can't already be cached.
  onCdcEvent((event) => {
    if (event.table !== 'library') return;
    if (event.action !== 'UPDATE' && event.action !== 'DELETE') return;
    if (!event.data) return;
    const id = (event.data as Record<string, unknown>).id;
    if (typeof id !== 'number') return;
    invalidateDiscogsUnavailableFlags(id);
  });
}
