/**
 * HTTP client for the tubafrenzy mirror API.
 *
 * Mirrors flowsheet entries and radio shows to tubafrenzy via REST endpoints:
 * - POST/PATCH /playlists/api/flowsheetEntry — entry CRUD
 * - POST /playlists/api/radioShow — show creation
 * - POST /playlists/api/radioShow/signoff — show sign-off
 */

import * as Sentry from '@sentry/node';

const TUBAFRENZY_URL = process.env.TUBAFRENZY_URL ?? 'https://www.wxyc.info';
const MIRROR_API_KEY = process.env.MIRROR_API_KEY ?? '';

/** In-memory map: Backend-Service play_order → tubafrenzy entry ID */
const entryIdMap = new Map<number, number>();

/**
 * In-memory map: Backend-Service show ID → tubafrenzy show ID.
 *
 * Process-local, non-durable. Populated lazily by `cacheShowId` after a
 * successful `mirrorCreateShow`; cleared on process exit. On BS restart the
 * map starts empty — restart resilience comes from `shows.legacy_show_id`
 * (persisted by `flowsheet.mirror.ts:52` after the same `mirrorCreateShow`
 * call) which the mirror read path falls back to when the cache misses
 * (`flowsheet.mirror.ts:84`: `getCachedShowId(show.id) ?? show.legacy_show_id`).
 */
const showIdMap = new Map<number, number>();

interface MirrorEntry {
  entry_type: string;
  artist_name?: string | null;
  track_title?: string | null;
  album_title?: string | null;
  record_label?: string | null;
  album_id?: number | null;
  rotation_id?: number | null;
  request_flag?: boolean;
  segue?: boolean;
  message?: string | null;
  add_time?: Date | string | number | null;
  play_order: number;
}

/**
 * Mirror operation taxonomy. Each operation declares:
 *
 *   - `category`: `'http'` for outbound tubafrenzy calls (the 2026-06-05
 *     runbook is keyed on `category:http`); `'db'` for local DB queries
 *     in the helper layer.
 *
 *   - `useFingerprint`: whether the Sentry event opts into an explicit
 *     `['mirror-failure', operation]` fingerprint. The pre-existing HTTP
 *     ops DO NOT fingerprint — they group via Sentry's default
 *     message-based grouping to preserve their existing issue lineage
 *     (alert rules / muted-issue subscriptions / runbook links wired to
 *     historical IDs would silently stop firing if we forked the
 *     lineage). `rotation_lookup` is new in BS#1432, so it opts into an
 *     explicit fingerprint from the start.
 *
 *   - `useException`: whether `Error`-valued failures route through
 *     `Sentry.captureException` (true) or stay on `captureMessage`
 *     (false). The pre-existing HTTP ops MUST stay on captureMessage
 *     even for catch-arm Errors: Sentry's default exception-grouping
 *     algorithm keys by exception type + top stack frame, NOT by the
 *     `Mirror: <op> failed` message string. Routing HTTP-op Errors
 *     through captureException would silently fork their issue lineage
 *     (round-3 review caught this). `rotation_lookup` opts into the
 *     captureException lane because it's a new op with no historical
 *     lineage to preserve, and its explicit fingerprint overrides
 *     Sentry's default exception grouping anyway.
 *
 * Adding a new operation REQUIRES a new entry here — TypeScript's
 * `satisfies Record<MirrorOperation, MirrorOperationMeta>` enforces
 * exhaustiveness. `as const` preserves literal types so consumers see
 * narrow `'http' | 'db'` and literal-`true`/`false` types instead of
 * widened `string` / `boolean`. `Object.freeze` makes the registry
 * actually immutable at runtime — `as const` is TypeScript-only, so
 * without the freeze a downstream importer doing `(meta as any).x = y`
 * could corrupt grouping for the lifetime of the process.
 */
export type MirrorOperation = 'create_entry' | 'update_entry' | 'signoff_show' | 'rotation_lookup';

interface MirrorOperationMeta {
  category: 'http' | 'db';
  useFingerprint: boolean;
  useException: boolean;
}

export const MIRROR_OPERATION_META = Object.freeze({
  create_entry: Object.freeze({ category: 'http', useFingerprint: false, useException: false }),
  update_entry: Object.freeze({ category: 'http', useFingerprint: false, useException: false }),
  signoff_show: Object.freeze({ category: 'http', useFingerprint: false, useException: false }),
  rotation_lookup: Object.freeze({ category: 'db', useFingerprint: true, useException: true }),
} as const) satisfies Readonly<Record<MirrorOperation, Readonly<MirrorOperationMeta>>>;

/** Defensive cap for stack-trace strings sent to Sentry, mirroring the
 *  responseBody cap pattern. Long async stacks from drizzle + postgres-js
 *  wrappers can be many KB; Sentry's per-event payload limit is finite,
 *  and under sustained outage we emit one event per entry add/update.
 *  Only applied on the captureMessage path (where we manually surface the
 *  stack via `extra.stack`). The captureException path relies on Sentry's
 *  native exception lane, which has its own framing/truncation. */
const STACK_TRACE_MAX_LENGTH = 4000;

/**
 * Capture a mirror call failure to Sentry. Routing is governed by the
 * per-operation entry in `MIRROR_OPERATION_META`:
 *
 *   - HTTP operations (`create_entry`, `update_entry`, `signoff_show`)
 *     always emit via `Sentry.captureMessage` regardless of whether the
 *     failure is a status code (`!response.ok`) or a catch-arm Error
 *     (network error, fetch reject). This preserves their historical
 *     issue identity: Sentry's default message grouping keys on
 *     `'Mirror: <op> failed'`, so all four failure-mode subsets (401,
 *     5xx, ECONNREFUSED, timeout) roll into the same operation-keyed
 *     issue. The on-call runbook (2026-06-05 tubafrenzy auth-config
 *     drift) is wired to that issue lineage. Error stacks are surfaced
 *     via `extra.stack` (sliced to `STACK_TRACE_MAX_LENGTH`) since
 *     captureMessage doesn't auto-extract them.
 *
 *   - The DB operation (`rotation_lookup`) emits via
 *     `Sentry.captureException` for Error-valued failures, with an
 *     explicit fingerprint `['mirror-failure', 'rotation_lookup']` so
 *     it's grouped under a dedicated issue from the start (new in
 *     BS#1432). Sentry's native exception lane handles the stack —
 *     matches the codebase pattern in enrichment-worker / auth /
 *     provision-user. Non-Error failures (defensive — should be rare)
 *     fall through to captureMessage with the same fingerprint.
 *
 * `status` is captured as a tag (filterable in search but not part of
 * the group hash) so a sustained outage rolls up into a single issue
 * with an occurrence count rather than fanning out per-row.
 */
export function captureMirrorFailure(
  operation: MirrorOperation,
  details: { status?: number; responseBody?: string; error?: unknown },
  level: 'error' | 'warning' = 'error'
): void {
  const meta = MIRROR_OPERATION_META[operation];
  const fingerprint: string[] | undefined = meta.useFingerprint ? ['mirror-failure', operation] : undefined;
  const tags: Record<string, string> = {
    subsystem: 'legacy-mirror',
    operation,
    category: meta.category,
    ...(details.status != null ? { status: String(details.status) } : {}),
  };
  const extra: Record<string, unknown> = {
    ...(details.status != null ? { status: details.status } : {}),
    ...(details.responseBody != null ? { responseBody: details.responseBody.slice(0, 500) } : {}),
  };

  // captureException path: only for ops that opt in (currently just
  // rotation_lookup) AND only when the failure is a real Error. Sentry's
  // native exception lane handles the stack; no manual `extra.stack`
  // forwarding here (matches the convention in enrichment-worker / auth
  // / provision-user / check-request-ban-handler — none of those sites
  // duplicate err.stack into extra).
  if (meta.useException && details.error instanceof Error) {
    Sentry.captureException(details.error, {
      level,
      ...(fingerprint != null ? { fingerprint } : {}),
      tags,
      extra,
    });
    return;
  }

  // captureMessage path: HTTP ops always (preserves message-grouped
  // issue lineage even for catch-arm Errors), plus the defensive
  // non-Error rotation_lookup case. Surface the error value as a
  // stringified summary; for Error instances, also forward a truncated
  // stack via extra so triagers don't lose it (captureMessage doesn't
  // auto-extract stacks the way captureException does).
  if (details.error != null) {
    extra.error = String(details.error);
    if (details.error instanceof Error && details.error.stack != null) {
      extra.stack = details.error.stack.slice(0, STACK_TRACE_MAX_LENGTH);
    }
  }
  Sentry.captureMessage(`Mirror: ${operation} failed`, {
    level,
    ...(fingerprint != null ? { fingerprint } : {}),
    tags,
    extra,
  });
}

/**
 * POST a new entry to tubafrenzy. Returns the created entry's ID, or null on failure.
 * Never throws — errors are logged and swallowed (fire-and-forget).
 */
export async function mirrorCreateEntry(body: Record<string, unknown>): Promise<number | null> {
  try {
    const response = await fetch(`${TUBAFRENZY_URL}/playlists/api/flowsheetEntry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIRROR_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[mirror] POST failed: ${response.status} ${text}`);
      captureMirrorFailure('create_entry', { status: response.status, responseBody: text });
      return null;
    }
    const json = (await response.json()) as { id?: number | null };
    return json.id ?? null;
  } catch (e) {
    console.error('[mirror] POST error:', e);
    captureMirrorFailure('create_entry', { error: e });
    return null;
  }
}

/**
 * PATCH an existing entry on tubafrenzy by its tubafrenzy ID.
 * Never throws — errors are logged and swallowed (fire-and-forget).
 */
export async function mirrorUpdateEntry(tubafrenzyId: number, body: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(`${TUBAFRENZY_URL}/playlists/api/flowsheetEntry`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIRROR_API_KEY}`,
      },
      body: JSON.stringify({ id: tubafrenzyId, ...body }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[mirror] PATCH failed: ${response.status} ${text}`);
      captureMirrorFailure('update_entry', { status: response.status, responseBody: text });
    }
  } catch (e) {
    console.error('[mirror] PATCH error:', e);
    captureMirrorFailure('update_entry', { error: e });
  }
}

export function cacheEntryId(playOrder: number, tubafrenzyId: number): void {
  entryIdMap.set(playOrder, tubafrenzyId);
}

export function getCachedEntryId(playOrder: number): number | undefined {
  return entryIdMap.get(playOrder);
}

export function clearEntryIdMap(): void {
  entryIdMap.clear();
}

/**
 * Maps a Backend-Service FSEntry to the tubafrenzy POST JSON body.
 * When radioShowID is provided, it's included so tubafrenzy doesn't auto-resolve.
 * nowPlayingFlag is always 0 (dropped — nothing in tubafrenzy reads it).
 */
export function mapEntryToTubafrenzy(
  entry: MirrorEntry,
  radioShowID?: number | null,
  isRotationMatch = false
): Record<string, unknown> {
  const startMs = entry.add_time ? new Date(entry.add_time).getTime() : Date.now();
  const radioHour = Math.floor(startMs / 3_600_000) * 3_600_000;

  const entryType = entry.entry_type;

  // Non-track entries
  if (isNonTrackEntry(entryType, entry.message)) {
    let message = entry.message?.trim() ?? '';
    let flowsheetEntryType = 7; // default talkset
    let startTime = 0;

    if (entryType === 'show_start') {
      flowsheetEntryType = 9;
      startTime = startMs;
    } else if (entryType === 'show_end') {
      flowsheetEntryType = 10;
      startTime = startMs;
    } else if (entryType === 'dj_join' || entryType === 'dj_leave') {
      flowsheetEntryType = 7;
    } else if (entryType === 'talkset' || entryType === 'message') {
      flowsheetEntryType = 7;
      message = '------ talkset -------';
    } else if (entryType === 'breakpoint') {
      flowsheetEntryType = 8;
      message = message.toUpperCase() || 'BREAKPOINT';
    } else {
      // Legacy pattern matching
      if (message.toLowerCase().includes('breakpoint')) {
        flowsheetEntryType = 8;
        message = message.toUpperCase();
      } else if (message.toLowerCase().includes('start of show') || message.toLowerCase().includes('signed on')) {
        flowsheetEntryType = 9;
        startTime = startMs;
      } else if (message.toLowerCase().includes('end of show') || message.toLowerCase().includes('signed off')) {
        flowsheetEntryType = 10;
        startTime = startMs;
      } else {
        message = '------ talkset -------';
      }
    }

    return {
      ...(radioShowID != null ? { radioShowID } : {}),
      radioHour,
      flowsheetEntryType,
      artistName: message,
      startTime,
    };
  }

  // Track entries.
  //
  // Gate `entry.rotation_id && entry.rotation_id > 0` is intentionally
  // looser than the helper's `entry.rotation_id != null` (BS#1432 round-2
  // tightened the helper for read-path parity). End-to-end the two
  // surfaces still agree: for `rotation_id = 0` the helper short-circuits
  // (returns false), `isRotationMatch` is false, this branch falls through
  // to the album_id check — yielding the same classification the read
  // path would produce (FK join misses, IS-NULL-gated subquery doesn't
  // fire, no badge). Schema FK to `rotation.id` (a serial starting at 1)
  // makes `rotation_id = 0` theoretical drift in practice, but keeping
  // this gate aligned with the schema-positive invariant rather than the
  // helper's "any non-NULL = FK lane owns it" semantic preserves the
  // explicit "real rotation FK" intent at the mapper layer.
  let flowsheetEntryType = 0;
  if ((entry.rotation_id && entry.rotation_id > 0) || isRotationMatch) {
    flowsheetEntryType = 2;
  } else if (entry.album_id && entry.album_id > 0) {
    flowsheetEntryType = 6;
  }

  return {
    ...(radioShowID != null ? { radioShowID } : {}),
    radioHour,
    flowsheetEntryType,
    artistName: entry.artist_name ?? '',
    songTitle: entry.track_title ?? '',
    releaseTitle: entry.album_title ?? '',
    labelName: entry.record_label ?? '',
    request: entry.request_flag ?? false,
    segue: entry.segue ?? false,
    nowPlayingFlag: 0,
    libraryReleaseID: entry.album_id ?? 0,
    rotationReleaseID: entry.rotation_id ?? 0,
  };
}

/**
 * Maps a Backend-Service FSEntry to the tubafrenzy PATCH JSON body.
 * Only includes fields that can be updated on an existing entry.
 */
export function mapUpdateToTubafrenzy(entry: MirrorEntry, isRotationMatch = false): Record<string, unknown> {
  let flowsheetEntryType = 0;
  if ((entry.rotation_id && entry.rotation_id > 0) || isRotationMatch) {
    flowsheetEntryType = 2;
  } else if (entry.album_id && entry.album_id > 0) {
    flowsheetEntryType = 6;
  }

  return {
    artistName: entry.artist_name ?? '',
    songTitle: entry.track_title ?? '',
    releaseTitle: entry.album_title ?? '',
    labelName: entry.record_label ?? '',
    request: entry.request_flag ?? false,
    segue: entry.segue ?? false,
    libraryReleaseID: entry.album_id ?? 0,
    rotationReleaseID: entry.rotation_id ?? 0,
    flowsheetEntryType,
  };
}

// ── Show mirror functions ──────────────────────────────────────────────

/**
 * POST a new radio show to tubafrenzy. Retries up to 5 times with exponential
 * backoff (base 500ms, max 8s) because a failed show creation cascades: every
 * subsequent entry will lack a radioShowID. Returns the tubafrenzy show ID, or
 * null after all retries fail.
 */
export async function mirrorCreateShow(body: Record<string, unknown>): Promise<number | null> {
  const MAX_ATTEMPTS = 5;
  const BASE_BACKOFF_MS = 500;
  const MAX_BACKOFF_MS = 8_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${TUBAFRENZY_URL}/playlists/api/radioShow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MIRROR_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const json = (await response.json()) as { id?: number | null };
        return json.id ?? null;
      }
      const text = await response.text();
      console.error(`[mirror] POST radioShow failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${response.status} ${text}`);
    } catch (e) {
      console.error(`[mirror] POST radioShow error (attempt ${attempt}/${MAX_ATTEMPTS}):`, e);
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  Sentry.captureMessage('Mirror: show creation failed after all retries', {
    level: 'error',
    tags: { subsystem: 'legacy-mirror' },
    extra: { body },
  });
  return null;
}

/**
 * POST a show signoff to tubafrenzy. Fire-and-forget (single attempt).
 * Signoff failure doesn't cascade — the show already exists in tubafrenzy.
 */
export async function mirrorSignoffShow(radioShowId: number, signoffTime: number): Promise<void> {
  try {
    const response = await fetch(`${TUBAFRENZY_URL}/playlists/api/radioShow/signoff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIRROR_API_KEY}`,
      },
      body: JSON.stringify({ radioShowId, signoffTime }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[mirror] POST radioShow/signoff failed: ${response.status} ${text}`);
      captureMirrorFailure('signoff_show', { status: response.status, responseBody: text });
    }
  } catch (e) {
    console.error('[mirror] POST radioShow/signoff error:', e);
    captureMirrorFailure('signoff_show', { error: e });
  }
}

export function cacheShowId(backendShowId: number, tubafrenzyShowId: number): void {
  showIdMap.set(backendShowId, tubafrenzyShowId);
}

export function getCachedShowId(backendShowId: number): number | undefined {
  return showIdMap.get(backendShowId);
}

export function clearShowIdMap(): void {
  showIdMap.clear();
}

interface MirrorShow {
  id: number;
  show_name?: string | null;
  specialty_id?: number | null;
  start_time?: Date | string | number | null;
  // BS#1321: per-show display-name override (migration 0090). When non-null
  // takes precedence over `dj.djName` for the tubafrenzy `djHandle` so the
  // mirror surface (which the legacy tubafrenzy admin UI + on-air playlist
  // both render) reflects the operator-intent override for the whole show,
  // not just the BS-side flowsheet rows.
  dj_name_override?: string | null;
}

interface MirrorDJ {
  realName?: string | null;
  djName?: string | null;
  name: string;
}

/**
 * Maps a Backend-Service Show + user to the tubafrenzy radioShow POST body.
 *
 * `djHandle` picks the per-show override first (BS#1321) so the mirror
 * surface matches every other consumer of `resolveDjNameForShow`. If no
 * override is set, fall back to the DJ's stage handle (`auth_user.dj_name`)
 * and then to their name. `djName` (note: capital N — tubafrenzy's distinct
 * "real-name" field) is always `realName || name`; we don't override it
 * because the upstream surface treats `djName` as "the human behind the
 * mic" rather than "the on-air display name", and the override is the
 * latter, not the former.
 */
export function mapShowToTubafrenzy(show: MirrorShow, dj: MirrorDJ): Record<string, unknown> {
  const startMs = show.start_time ? new Date(show.start_time).getTime() : Date.now();
  const override = show.dj_name_override?.trim();
  const djHandle = override && override.length > 0 ? override : dj.djName || dj.name;
  return {
    djName: dj.realName || dj.name,
    djHandle,
    djId: 0,
    showName: show.show_name ?? '',
    specialtyShowId: show.specialty_id ?? 0,
    signonTime: startMs,
  };
}

function isNonTrackEntry(entryType: string, message?: string | null): boolean {
  return (
    entryType === 'show_start' ||
    entryType === 'show_end' ||
    entryType === 'dj_join' ||
    entryType === 'dj_leave' ||
    entryType === 'talkset' ||
    entryType === 'breakpoint' ||
    entryType === 'message' ||
    (!!message?.trim() && entryType !== 'track')
  );
}
