import { jest } from '@jest/globals';
import { desc, sql } from 'drizzle-orm';
// Local binding for use within this file (the `export { ... } from '...'`
// re-export further down forwards the same names to consumers but does not
// itself introduce a usable local identifier).
import { requireNonNegativeInt } from '../../shared/database/src/env-parsers.js';

type MockQueryChain = {
  select: jest.Mock;
  selectDistinctOn: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  groupBy: jest.Mock;
  as: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
  insert: jest.Mock;
  values: jest.Mock;
  onConflictDoNothing: jest.Mock;
  onConflictDoUpdate: jest.Mock;
  returning: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  delete: jest.Mock;
  execute: jest.Mock;
};

export function createMockQueryChain(resolvedValue: unknown = []): MockQueryChain {
  const chain: MockQueryChain = {} as MockQueryChain;

  const chainMethods = [
    'select',
    'selectDistinctOn',
    'from',
    'where',
    'innerJoin',
    'leftJoin',
    // `groupBy` is part of the query builder this stub models (BS#2235's
    // `buildOpenShowsQuery` is the first caller here); without it an aggregate
    // read fails as "groupBy is not a function" rather than returning the chain.
    'groupBy',
    // `.as(alias)` closes a subquery so it can be selected FROM. BS#2235's
    // `buildOpenShowsQuery` is the first caller here; without it a subquery
    // build fails as "as is not a function" rather than returning the chain.
    'as',
    'orderBy',
    'limit',
    'insert',
    'values',
    'update',
    'set',
    'delete',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'offset',
  ];

  chainMethods.forEach((method) => {
    (chain as Record<string, jest.Mock>)[method] = jest.fn().mockReturnValue(chain);
  });

  (chain as Record<string, jest.Mock>).returning = jest.fn().mockResolvedValue(resolvedValue);
  (chain as Record<string, jest.Mock>).execute = jest.fn().mockResolvedValue(resolvedValue);

  return chain;
}

export function createMockDb() {
  const mockChain = createMockQueryChain();
  const mockDb = {
    select: mockChain.select,
    selectDistinctOn: mockChain.selectDistinctOn,
    insert: mockChain.insert,
    update: mockChain.update,
    delete: mockChain.delete,
    execute: mockChain.execute,
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => fn(mockDb)),
    _chain: mockChain,
  };
  return mockDb;
}

// Mock database client
export const db = createMockDb();

// Mock table schemas (empty objects that can be used in queries)
export const anonymous_devices = {};
export const user_activity = {};
export const labels = {};
export const library = {
  id: 'id',
  artist_id: 'artist_id',
  legacy_release_id: 'legacy_release_id',
  on_streaming: 'on_streaming',
  artwork_url: 'artwork_url',
  artist_name: 'artist_name',
  search_doc: 'search_doc',
  canonical_entity_id: 'canonical_entity_id',
  canonical_entity_confidence: 'canonical_entity_confidence',
  canonical_entity_resolved_at: 'canonical_entity_resolved_at',
  discogs_unavailable: 'discogs_unavailable',
  discogs_unavailable_note: 'discogs_unavailable_note',
  last_discogs_recheck_at: 'last_discogs_recheck_at',
};
// BS#2112. Written by `deleteAlbumFromDB` in the same transaction as the
// delete; read by `jobs/library-etl`. Its only consumer is the ETL — no read
// path filters on it.
export const library_delete_denylist = {
  legacy_release_id: 'legacy_release_id',
  library_id: 'library_id',
  deleted_at: 'deleted_at',
};
export const album_popularity = {
  logical_album_key: 'logical_album_key',
  plays: 'plays',
  linked_plays: 'linked_plays',
  freetext_plays: 'freetext_plays',
  representative_library_id: 'representative_library_id',
};
export const artists = {
  id: 'id',
  artist_name: 'artist_name',
  discogs_artist_id: 'discogs_artist_id',
};
export const genres = {};
export const format = {};
export const rotation = {
  id: 'id',
  album_id: 'album_id',
  legacy_rotation_id: 'legacy_rotation_id',
  legacy_library_release_id: 'legacy_library_release_id',
  rotation_bin: 'rotation_bin',
  add_date: 'add_date',
  kill_date: 'kill_date',
  artist_name: 'artist_name',
  album_title: 'album_title',
  record_label: 'record_label',
  discogs_release_id: 'discogs_release_id',
  discogs_release_id_resolve_attempted_at: 'discogs_release_id_resolve_attempted_at',
  tracklist_lookup_attempted_at: 'tracklist_lookup_attempted_at',
};
export const library_identity = {
  library_id: 'library_id',
  discogs_release_id: 'discogs_release_id',
};
export const library_identity_source = {
  library_id: 'library_id',
  source: 'source',
  external_id: 'external_id',
};
export const library_artist_view = {
  on_streaming: 'on_streaming',
  artist_id: 'artist_id',
};
export const artist_search_alias = {
  artist_id: 'artist_id',
  source: 'source',
  variant: 'variant',
  related_artist_id: 'related_artist_id',
  external_subject_id: 'external_subject_id',
  external_object_id: 'external_object_id',
  active: 'active',
  method: 'method',
  confidence: 'confidence',
  last_verified_at: 'last_verified_at',
};
export const venues = {
  id: 'id',
  slug: 'slug',
  name: 'name',
  city: 'city',
  state: 'state',
  address: 'address',
  added_at: 'added_at',
  last_modified: 'last_modified',
};
export const concerts = {
  id: 'id',
  source: 'source',
  source_id: 'source_id',
  venue_id: 'venue_id',
  starts_on: 'starts_on',
  starts_at: 'starts_at',
  doors_at: 'doors_at',
  headlining_artist_raw: 'headlining_artist_raw',
  title: 'title',
  headlining_artist_id: 'headlining_artist_id',
  headlining_discogs_artist_id: 'headlining_discogs_artist_id',
  headlining_discogs_artist_id_source: 'headlining_discogs_artist_id_source',
  artist_resolve_attempted_at: 'artist_resolve_attempted_at',
  supporting_artists_raw: 'supporting_artists_raw',
  ticket_url: 'ticket_url',
  image_url: 'image_url',
  price_min: 'price_min',
  price_max: 'price_max',
  age_restriction: 'age_restriction',
  status: 'status',
  removed_at: 'removed_at',
  raw_data: 'raw_data',
  scraped_at: 'scraped_at',
  first_scraped_at: 'first_scraped_at',
  has_resolved_support: 'has_resolved_support',
  last_modified: 'last_modified',
};
// Named `concertPerformers` (camelCase) to match the real export in
// shared/database/src/schema.ts — unlike most multi-word tables in this
// mock file (e.g. `artist_search_alias`), the real schema.ts binding for
// `concert_performers` is camelCase.
export const concertPerformers = {
  id: 'id',
  concert_id: 'concert_id',
  raw_name: 'raw_name',
  role: 'role',
  artist_id: 'artist_id',
  discogs_artist_id: 'discogs_artist_id',
  discogs_artist_id_source: 'discogs_artist_id_source',
  artist_resolve_attempted_at: 'artist_resolve_attempted_at',
  removed_at: 'removed_at',
  created_at: 'created_at',
};
export const album_plays = {
  album_id: 'album_id',
  plays: 'plays',
};
export const flowsheet = {
  id: 'id',
  show_id: 'show_id',
  album_id: 'album_id',
  legacy_entry_id: 'legacy_entry_id',
  legacy_release_id: 'legacy_release_id',
  legacy_link_attempted_at: 'legacy_link_attempted_at',
  metadata_attempt_at: 'metadata_attempt_at',
  entry_type: 'entry_type',
  track_title: 'track_title',
  album_title: 'album_title',
  artist_name: 'artist_name',
  record_label: 'record_label',
  label_id: 'label_id',
  rotation_id: 'rotation_id',
  play_order: 'play_order',
  request_flag: 'request_flag',
  segue: 'segue',
  message: 'message',
  add_time: 'add_time',
  updated_at: 'updated_at',
  artwork_url: 'artwork_url',
  discogs_url: 'discogs_url',
  release_year: 'release_year',
  spotify_url: 'spotify_url',
  apple_music_url: 'apple_music_url',
  youtube_music_url: 'youtube_music_url',
  bandcamp_url: 'bandcamp_url',
  soundcloud_url: 'soundcloud_url',
  artist_bio: 'artist_bio',
  artist_wikipedia_url: 'artist_wikipedia_url',
  dj_name: 'dj_name',
  metadata_status: 'metadata_status',
  enriching_since: 'enriching_since',
  // BS#2176: retry marker for jobs/flowsheet-no-match-recheck. See
  // shared/database/src/schema.ts + migration 0151.
  no_match_recheck_attempted_at: 'no_match_recheck_attempted_at',
  linkage_source: 'linkage_source',
  linkage_confidence: 'linkage_confidence',
  linked_at: 'linked_at',
  search_doc: 'search_doc',
};
export const flowsheet_watermark = {
  id: 'id',
  last_modified_at: 'last_modified_at',
};
export const library_watermark = {
  id: 'id',
  last_modified_at: 'last_modified_at',
};
export const album_metadata = {
  album_id: 'album_id',
  artwork_url: 'artwork_url',
  discogs_url: 'discogs_url',
  release_year: 'release_year',
  spotify_url: 'spotify_url',
  apple_music_url: 'apple_music_url',
  youtube_music_url: 'youtube_music_url',
  bandcamp_url: 'bandcamp_url',
  soundcloud_url: 'soundcloud_url',
  artist_bio: 'artist_bio',
  artist_wikipedia_url: 'artist_wikipedia_url',
  discogs_artist_id: 'discogs_artist_id',
  label: 'label',
  full_release_date: 'full_release_date',
  genres: 'genres',
  styles: 'styles',
  tracklist: 'tracklist',
  artist_image_url: 'artist_image_url',
  bio_tokens: 'bio_tokens',
  // BS#1915: per-service streaming resolution status + shared re-ask
  // attempt counter — see shared/database/src/schema.ts and
  // apps/enrichment-worker/enrich.ts (mergeStreamingField).
  spotify_status: 'spotify_status',
  apple_music_status: 'apple_music_status',
  bandcamp_status: 'bandcamp_status',
  streaming_reask_attempts: 'streaming_reask_attempts',
  updated_at: 'updated_at',
};
export const artist_metadata = {
  discogs_artist_id: 'discogs_artist_id',
  genres: 'genres',
  styles: 'styles',
  updated_at: 'updated_at',
};
export const artist_similar_artists = {
  artist_id: 'artist_id',
  neighbors: 'neighbors',
  updated_at: 'updated_at',
};
export const artist_station_plays = {
  artist_id: 'artist_id',
  plays: 'plays',
  updated_at: 'updated_at',
};
export const discogs_artist_similar_artists = {
  discogs_artist_id: 'discogs_artist_id',
  neighbors: 'neighbors',
  updated_at: 'updated_at',
};
export const flowsheet_freetext_resolution = {
  norm_artist: 'norm_artist',
  norm_album: 'norm_album',
  discogs_release_id: 'discogs_release_id',
  discogs_master_id: 'discogs_master_id',
  match_confidence: 'match_confidence',
  match_source: 'match_source',
  attempt_at: 'attempt_at',
  resolved_at: 'resolved_at',
};
export const album_review_submissions = {
  id: 'id',
  album_id: 'album_id',
  artist_name: 'artist_name',
  album_title: 'album_title',
  record_label: 'record_label',
  artist_blurb: 'artist_blurb',
  review: 'review',
  recommended_tracks: 'recommended_tracks',
  buzzwords: 'buzzwords',
  fcc_violations: 'fcc_violations',
  review_purpose: 'review_purpose',
  reviewer_raw: 'reviewer_raw',
  social_consent_raw: 'social_consent_raw',
  social_consent: 'social_consent',
  released_within_six_months: 'released_within_six_months',
  rotated: 'rotated',
  submitted_at: 'submitted_at',
  source: 'source',
  source_key: 'source_key',
  norm_artist: 'norm_artist',
  norm_album: 'norm_album',
  add_date: 'add_date',
  last_modified: 'last_modified',
};
export const album_critic_reviews = {
  id: 'id',
  album_id: 'album_id',
  source: 'source',
  source_url: 'source_url',
  snippet: 'snippet',
  author: 'author',
  published_at: 'published_at',
  rating: 'rating',
  discogs_release_id: 'discogs_release_id',
  source_key: 'source_key',
  created_at: 'created_at',
  last_modified: 'last_modified',
};
// jobs/uncovered-release-list's "searched, found nothing" marker (BS#1877,
// ADR 0013). See schema.ts's doc comment on uncovered_release_search_markers
// for why this is a dedicated table rather than a source_key convention on
// album_critic_reviews.
export const uncovered_release_search_markers = {
  id: 'id',
  album_id: 'album_id',
  first_handed_off_at: 'first_handed_off_at',
  last_handed_off_at: 'last_handed_off_at',
  handoff_count: 'handoff_count',
};
export const flowsheet_linkage_review = {
  id: 'id',
  flowsheet_id: 'flowsheet_id',
  candidate_library_ids: 'candidate_library_ids',
  candidate_confidences: 'candidate_confidences',
  suggested_action: 'suggested_action',
  created_at: 'created_at',
  reviewed_at: 'reviewed_at',
  reviewed_decision: 'reviewed_decision',
};
export const bins = {
  id: 'id',
  dj_id: 'dj_id',
  album_id: 'album_id',
  track_title: 'track_title',
};
export const shows = {
  id: 'id',
  primary_dj_id: 'primary_dj_id',
  legacy_dj_name: 'legacy_dj_name',
  legacy_dj_id: 'legacy_dj_id',
  legacy_show_id: 'legacy_show_id',
  dj_name_override: 'dj_name_override',
  start_time: 'start_time',
  end_time: 'end_time',
  show_name: 'show_name',
  specialty_id: 'specialty_id',
};
export const show_djs = {
  show_id: 'show_id',
  dj_id: 'dj_id',
  active: 'active',
};
export const user = {
  id: 'id',
  name: 'name',
  email: 'email',
  emailVerified: 'email_verified',
  image: 'image',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  role: 'role',
  banned: 'banned',
  banReason: 'ban_reason',
  banExpires: 'ban_expires',
  username: 'username',
  displayUsername: 'display_username',
  realName: 'real_name',
  djName: 'dj_name',
  appSkin: 'app_skin',
  isAnonymous: 'is_anonymous',
  capabilities: 'capabilities',
};
export const banned_fingerprints = {
  fingerprint: 'fingerprint',
  banned_at: 'banned_at',
  ban_reason: 'ban_reason',
  ban_expires_at: 'ban_expires_at',
  banned_by_user_id: 'banned_by_user_id',
};
export const slack_ban_moderators = {
  slack_user_id: 'slack_user_id',
  added_at: 'added_at',
  added_by_slack_user_id: 'added_by_slack_user_id',
};
export const specialty_shows = {};
export const schedule = {};
export const artist_crossreference = {};
export const artist_library_crossreference = {
  artist_id: 'artist_id',
  library_id: 'library_id',
};
export const compilation_track_artist = {
  id: 'id',
  library_id: 'library_id',
  artist_name: 'artist_name',
  track_title: 'track_title',
  track_position: 'track_position',
  // BS#1990 (#801 S1) / migration 0140 — the per-track artist
  // canonicalization link. Mirrored here so the S2 consumer arm's unit tests
  // can't assert against a row shape the real table could never produce.
  track_artist_id: 'track_artist_id',
  track_artist_link_confidence: 'track_artist_link_confidence',
  track_artist_link_method: 'track_artist_link_method',
};
export const genre_artist_crossreference = {
  artist_id: 'artist_id',
  genre_id: 'genre_id',
  artist_genre_code: 'artist_genre_code',
};

// Pure ETL utility functions (copied from etl-utils.ts to avoid importing the real DB client)
export const epochMsToDate = (epochMs: number | null): Date | null => {
  if (epochMs == null || epochMs === 0 || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date;
};

// BS#2143 future-timestamp bound. Mirrors
// shared/database/src/legacy/etl-utils.ts verbatim — kept in sync by hand
// like the rest of this file's "pure ETL utility functions" section; see
// tests/unit/database/etl-utils.test.ts for the real-module test that pins
// the actual implementation these callers depend on at runtime.
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
export const isBeyondFutureTolerance = (date: Date | null, now: Date = new Date()): boolean => {
  if (date === null) return false;
  return date.getTime() - now.getTime() > FUTURE_TIMESTAMP_TOLERANCE_MS;
};

// BS#1090: truncate on codepoint boundaries (Array.from), not UTF-16 code
// units (String.prototype.slice) — mirrors the real fix in
// shared/database/src/legacy/etl-utils.ts so this mock doesn't drift back
// into re-introducing the surrogate-pair-splitting bug for every caller
// that resolves `@wxyc/database` to this mock under unit tests.
export const truncate = (value: string | null | undefined, maxLength: number): string | null => {
  if (!value || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const codepoints = Array.from(trimmed);
  return codepoints.length <= maxLength ? trimmed : codepoints.slice(0, maxLength).join('');
};

export const parseTabRow = (line: string, columnCount: number): string[] | null => {
  const columns = line.split('\t');
  return columns.length === columnCount ? columns : null;
};

export const toNullable = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === 'NULL' ? null : trimmed;
};

// ETL cronjob tracking and lifecycle (from etl-utils.ts)
export const getLastRunTimestamp = jest.fn().mockResolvedValue(null);
export const updateLastRun = jest.fn().mockResolvedValue(undefined);
export const runPollingLoop = jest.fn().mockResolvedValue(undefined);
export const closeDatabaseConnection = jest.fn().mockResolvedValue(undefined);
export const cronjob_runs = {};

// Mock enum
export const flowsheetEntryTypeEnum = () => ({});

// B-2.3 multi-match tie-break. Tests that drive the linkage call sites
// (B-2.1 forward path, B-2.2 backfill) override this per-test to control
// which library_id the tie-break "picks".
export const pickPrimaryLibraryRow = jest.fn<(libraryIds: number[]) => Promise<number | null>>();

// Mirror the real defaults so resolvers fall back to numbers, not undefined.
// Drift is pinned by `tests/unit/database/live-activity.test.ts`.
export const LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT = 60;
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;
export type CheckLiveActivityFn = (lookbackSeconds: number) => Promise<boolean>;
export const checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);

// Mirrors of shared/database/src/live-activity.ts's BS#2147 additions
// (`resolveLiveActivityPauseMs`, `resolveLiveActivityMaxPauseMs`,
// `buildWaitForQuietPeriod`, `buildDefaultSleep`,
// `LiveActivityPauseCeilingExceededError`, and the constants). NOT
// re-exported from source: that module's `checkLiveActivity` import pulls in
// `./client.js`, which throws synchronously on missing DB env vars for every
// suite that resolves `@wxyc/database` to this mock (the same reason
// `truncate` / `isBeyondFutureTolerance` / `epochMsToDate` below are
// hand-duplicated rather than re-exported).
//
// This copy must stay BYTE-IDENTICAL to the real module — the four
// constants below, the `buildWaitForQuietPeriod` / `buildDefaultSleep`
// function bodies, the `resolveLiveActivityPauseMs` / `resolveLiveActivityMaxPauseMs`
// resolvers, and the `LiveActivityPauseCeilingExceededError` class (all via
// `Function.prototype.toString()`) are pinned against the real ones by
// `tests/unit/database/live-activity.test.ts`, which imports both directly
// by relative path. Prior to BS#2147 review round 2 (finding 7), that drift
// test pinned only two of the four constants and never touched the loop
// bodies at all, so the real module's throw-on-exhaustion fix (findings 1+2)
// would have shipped invisible to every job suite that resolves
// `@wxyc/database` to this mock. Prior to review round 2, LOW finding 5, the
// resolvers and the error class were ALSO unpinned despite this comment's
// blanket "must stay BYTE-IDENTICAL" claim — this comment previously (and
// wrongly) implied full coverage on both occasions. Any edit to the real
// module's `buildWaitForQuietPeriod`/`buildDefaultSleep`/
// `resolveLiveActivityPauseMs`/`resolveLiveActivityMaxPauseMs`/
// `LiveActivityPauseCeilingExceededError` MUST be copied here verbatim,
// comments included, or the drift test fails.
export const LIVE_ACTIVITY_MIN_PAUSE_MS = 1_000;
export const LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT = 1_800_000;
export const LIVE_ACTIVITY_MAX_PAUSE_MS_ENV = 'LIVE_ACTIVITY_MAX_PAUSE_MS';

export const resolveLiveActivityPauseMs = (
  raw: string | undefined,
  envName: string = 'LIVE_ACTIVITY_PAUSE_MS'
): number => {
  const resolved = requireNonNegativeInt(raw, envName, LIVE_ACTIVITY_PAUSE_MS_DEFAULT, { unit: 'ms' });
  if (resolved < LIVE_ACTIVITY_MIN_PAUSE_MS) {
    throw new Error(
      `Invalid ${envName}=${JSON.stringify(raw)}: must be >= ${LIVE_ACTIVITY_MIN_PAUSE_MS} (ms), or unset for the ` +
        `${LIVE_ACTIVITY_PAUSE_MS_DEFAULT}ms default. A value below the floor turns the cooperative-pause re-probe ` +
        'loop into a hot loop against the database instead of disabling it — use LIVE_ACTIVITY_LOOKBACK_SECONDS=0 ' +
        'to disable the pause.'
    );
  }
  return resolved;
};

export const resolveLiveActivityMaxPauseMs = (
  raw: string | undefined,
  envName: string = LIVE_ACTIVITY_MAX_PAUSE_MS_ENV
): number =>
  requireNonNegativeInt(raw, envName, LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT, {
    unit: 'ms',
    note: 'Cumulative pause budget for one waitForQuietPeriod call chain. 0 = uncapped; keep non-zero in production.',
  });

export class LiveActivityPauseCeilingExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveActivityPauseCeilingExceededError';
  }
}

export interface WaitForQuietPeriodPauseInfo {
  lookbackSeconds: number;
  pauseMs: number;
  pausedMs: number;
}

export interface WaitForQuietPeriodOptions {
  lookbackSeconds: number;
  pauseMs: number;
  probe?: CheckLiveActivityFn;
  shouldStop?: () => boolean;
  onPause?: (info: WaitForQuietPeriodPauseInfo) => void;
  onProbeError?: (err: unknown) => void;
  onBudgetExhausted?: (pausedMs: number) => void;
  maxTotalPauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const buildDefaultSleep = (shouldStop: () => boolean): ((ms: number) => Promise<void>) => {
  return async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (shouldStop()) return;
      const remaining = deadline - Date.now();
      const tick = Math.min(500, remaining);
      await new Promise<void>((resolve) => setTimeout(resolve, tick));
    }
  };
};

export const buildWaitForQuietPeriod = (opts: WaitForQuietPeriodOptions): (() => Promise<boolean>) => {
  const {
    lookbackSeconds,
    pauseMs,
    probe = checkLiveActivity,
    shouldStop = () => false,
    onPause,
    onProbeError,
    onBudgetExhausted,
    maxTotalPauseMs = LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT,
    sleep = buildDefaultSleep(shouldStop),
    now = () => performance.now(),
  } = opts;

  let pausedMs = 0;

  const safeProbe = async (): Promise<boolean> => {
    try {
      return await probe(lookbackSeconds);
    } catch (err) {
      onProbeError?.(err);
      return false;
    }
  };

  return async (): Promise<boolean> => {
    if (lookbackSeconds <= 0) return false;

    while (true) {
      const loopStart = now();
      const active = await safeProbe();
      if (!active) return shouldStop();
      if (shouldStop()) return true;

      if (maxTotalPauseMs > 0 && pausedMs >= maxTotalPauseMs) {
        onBudgetExhausted?.(pausedMs);
        throw new LiveActivityPauseCeilingExceededError(
          `Cooperative-pause budget exceeded: paused ${pausedMs}ms against a ${maxTotalPauseMs}ms ceiling ` +
            '(LIVE_ACTIVITY_MAX_PAUSE_MS); aborting instead of pausing indefinitely while DJs remain active.'
        );
      }

      onPause?.({ lookbackSeconds, pauseMs, pausedMs });
      await sleep(pauseMs);
      pausedMs += now() - loopStart;
    }
  };
};

// Stub of shared/database/src/concerts-recompute.ts's `recomputeHasResolvedSupport`
// (BS#1763). Consumers (jobs/concerts-artist-resolver's job.ts via its thin
// recompute.ts shim, jobs/concerts-artist-lml-resolver's job.ts directly) only
// need a controllable resolved value here — the real SQL-shape contract is
// pinned against the actual module by tests/unit/database/concerts-recompute.test.ts.
export type RecomputeOutcome = { updated: number; updated_true: number; updated_false: number };
export const recomputeHasResolvedSupport = jest
  .fn<() => Promise<RecomputeOutcome>>()
  .mockResolvedValue({ updated: 0, updated_true: 0, updated_false: 0 });

// Stub of shared/database/src/album-resolve.ts's `resolveLinkedAlbumId`
// (BS#1829, extracted from apps/backend/services/album-metadata-lookup.
// service.ts). Consumers (the service's thin re-export, scripts/
// seed-critic-reviews.ts, and eventually jobs/album-critic-reviews-etl)
// only need a controllable resolved value here — the real lookup-key +
// ORDER BY contract is pinned against the actual module by
// tests/unit/database/album-resolve.test.ts.
export const resolveLinkedAlbumId = jest
  .fn<(artistName: string, releaseTitle?: string) => Promise<number | null>>()
  .mockResolvedValue(null);

// Stub of shared/database/src/album-resolve.ts's `selectLinkedFlowsheetRow`
// (BS#1827, local-first playcut details — folded from a separate
// resolveLinkedFlowsheetBase into this combined-row shape in round 2 of the
// same slice, eliminating the two-query re-resolution race). The one
// consumer today (the service's thin re-export, read by
// apps/backend/controllers/proxy.controller.ts) only needs a controllable
// resolved value here — the real lookup-key + ORDER BY contract is pinned
// against the actual module by tests/unit/database/album-resolve.test.ts.
export interface LinkedFlowsheetRow {
  album_id: number;
  record_label: string | null;
  label_id: number | null;
  metadata_status: string;
}
export const selectLinkedFlowsheetRow = jest
  .fn<(artistName: string, releaseTitle?: string) => Promise<LinkedFlowsheetRow | null>>()
  .mockResolvedValue(null);

export { requirePositiveInt, requireNonNegativeInt } from '../../shared/database/src/env-parsers.js';
// BS#2173: re-exported (not re-declared) so the mock cannot drift from the real
// bin list. Safe because rotation-bin.ts is pure — no drizzle, no schema.ts,
// which is why that module exists separately from schema.ts in the first place.
export { ROTATION_BINS, parseRotationBin } from '../../shared/database/src/rotation-bin.js';
export type { RotationBin, RotationBinParse } from '../../shared/database/src/rotation-bin.js';
export type { IntParserOptions } from '../../shared/database/src/env-parsers.js';

// Same pure-module-path rationale as the env parsers above: `fold-artist-name`
// has no runtime deps, so re-exporting it directly (never via the `@wxyc/database`
// barrel) keeps `client.js` out of the mock. BS#2000's V/A arbiter layers the
// leading-anchored compilation rule on top of this exact fold so the SQL
// candidate net and the TS arbiter can't drift.
export { foldArtistName } from '../../shared/database/src/fold-artist-name.js';

// Same pure-module-path rationale: `intArrayLiteral` (BS#2010) has no
// runtime deps either, so the unit tests for its six call sites see the
// REAL validating implementation, not a jest.fn() stub.
export { intArrayLiteral } from '../../shared/database/src/int-array-literal.js';

// Same pure-module-path rationale for the PII-safe DJ-name chain (BS#2119
// review). It matters more here than for the other pure re-exports: a stub
// would let a consumer's test pass while the real chain disagrees, which is
// precisely the drift the extraction exists to prevent. The job tests assert
// their resolver AGAINST `resolveShowDjName`, so it must be the real one.
export { resolveDjDisplayName, showDjNameOverride, resolveShowDjName } from '../../shared/database/src/dj-name.js';

// Stubs of shared/database/src/last-logged-show-entry.ts (BS#2118 sites
// 5/7/8). NOT re-exported from source, unlike the pure dj-name chain above:
// the real module closes over the REAL `flowsheet` schema object, while
// consumers' assertions here compare against the MOCK `flowsheet` defined in
// this file, so a source re-export would make every shape-pin compare two
// different column objects. These stubs mirror the real implementations
// exactly, over the mock's own table object.
//
// The real module's behavior — including that it renders byte-identically to
// the hand-written fragments it replaced, and that it rejects an unsafe
// alias — is covered against SOURCE in
// tests/unit/database/last-logged-show-entry.test.ts, which unmocks
// drizzle-orm and imports the module directly.
export const lastLoggedShowEntryOrderBy = (): readonly [unknown] => [desc(flowsheet.id)];
export const lastLoggedShowEntryOrderBySql = (alias?: string): unknown =>
  alias ? sql`${sql.raw(alias)}.id DESC` : sql`${flowsheet.id} DESC`;

// Re-export the pure `RawPair` TYPE from source (type-only — erased at
// compile time, no runtime import, so it can't pull in the module's `db`
// dependency below).
export type { RawPair } from '../../shared/database/src/freetext-enumerate.js';

// Self-contained MOCK of shared/database/src/freetext-enumerate.ts's
// `enumerateFreetextPairs` (BS#1799 extraction from
// jobs/catalog-popularity-freetext-resolve/job.ts). Can't re-export the VALUE
// from source the way the pure normalizers above are (contrast
// normalizeArtistName/freetextPairKey/etc.): its `./client.js` import is a bare
// relative specifier that the `^.*/shared/database/src/client(\.js)?$` mapper
// entry below does NOT match (that regex requires the literal specifier to
// already contain "/shared/database/src/client", which a same-directory `./`
// import never does) — re-exporting it would load the REAL
// shared/database/src/client.ts unconditionally at THIS file's own import
// time and throw on missing DB env vars for every suite that imports
// `@wxyc/database`. This mock instead calls straight through THIS file's own
// `db` mock (the same `db.transaction` -> two `db.execute` calls -> row-
// mapping shape as the real function) so job.ts's `runResolve` unit tests,
// which drive `db.execute` with a sequenced `mockResolvedValueOnce` queue,
// keep consuming it in the same order unchanged. The real SQL-shape contract
// is pinned against the actual module directly by
// tests/unit/database/freetext-enumerate.test.ts.
//
// Wrapped in `jest.fn(...)` (BS#1822) so job.test.ts can assert `runResolve`
// threads `options.minPlays` into this call (`.mock.calls`) without needing to
// duplicate the real floor/order-by SQL logic here — that contract is pinned
// against the actual module by tests/unit/database/freetext-enumerate.test.ts
// and the real-PG integration spec. `clearMocks: true` in jest.unit.config.ts
// resets `.mock.calls` between tests but preserves this factory-supplied
// implementation (only `mockReset()`, not `mockClear()`, would drop it).
export const enumerateFreetextPairs = jest.fn(
  async (_timeoutMs?: number, _minPlays?: number): Promise<Array<{ artist: string; album: string; song: string }>> => {
    return db.transaction(async (tx: unknown) => {
      const { execute } = tx as { execute: (arg: unknown) => Promise<unknown> };
      await execute({}); // SET LOCAL statement_timeout placeholder
      const rows = (await execute({})) as Array<{
        artist_name: string;
        album_title: string;
        track_title: string | null;
      }>;
      return rows.map((r) => ({
        artist: String(r.artist_name),
        album: String(r.album_title),
        song: (r.track_title ?? '').trim(),
      }));
    }) as unknown as Promise<Array<{ artist: string; album: string; song: string }>>;
  }
);

// Pure normalizers (no DB dependency) re-exported from source so consumer jobs
// resolving @wxyc/database via this mock still get the real implementation.
export { normalizeArtistName } from '../../shared/database/src/normalize-artist-name.js';
export { normalizeAlbumTitle } from '../../shared/database/src/normalize-album-title.js';
export { freetextPairKey, normalizeFreetextArtist } from '../../shared/database/src/freetext-norm.js';
export { NY_TIME_ZONE, nyCalendarDate, nyStartOfDay, nyWallClockToUtc } from '../../shared/database/src/ny-time.js';

// Self-contained STUB of shared/database/src/concerts-sql.ts. The real
// module imports schema.ts, which calls drizzle's `eq` at module scope (a
// view definition) — re-exporting it here would break every suite that
// per-file-mocks 'drizzle-orm' with a partial factory (e.g. the
// album-plays/popularity-refresh suites). The stub mirrors the real
// fragment under the tests/__mocks__/drizzle-orm.ts sql-tag shape; the
// REAL module's text and column bindings are pinned by
// tests/unit/database/concerts-sql.test.ts.
export const headliningArtistIdConflictClear = (): { sql: readonly string[]; values: unknown[] } => ({
  sql: ['CASE WHEN ', ' IS DISTINCT FROM excluded."headlining_artist_raw" THEN NULL ELSE ', ' END'],
  values: ['<concerts.headlining_artist_raw>', '<concerts.headlining_artist_id>'],
});

export const imageUrlConflictCoalesce = (): { sql: readonly string[]; values: unknown[] } => ({
  sql: ['COALESCE(excluded."image_url", ', ')'],
  values: ['<concerts.image_url>'],
});

// Mock types
export type AnonymousDevice = {
  id: number;
  deviceId: string;
  createdAt: Date;
  lastSeenAt: Date;
  blocked: boolean;
  blockedAt: Date | null;
  blockedReason: string | null;
  requestCount: number;
};

export type Label = {
  id: number;
  label_name: string;
  parent_label_id: number | null;
};

export type NewLabel = Partial<Label>;

export type FSEntry = {
  id: number;
  show_id: number | null;
  album_id: number | null;
  rotation_id: number | null;
  legacy_entry_id: number | null;
  entry_type: string;
  track_title: string | null;
  album_title: string | null;
  artist_name: string | null;
  record_label: string | null;
  label_id: number | null;
  play_order: number;
  request_flag: boolean;
  segue: boolean;
  message: string | null;
  add_time: Date;
  artwork_url: string | null;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
  dj_name: string | null;
  linkage_source: string | null;
  linkage_confidence: number | null;
  linked_at: Date | null;
};

export type NewFSEntry = Partial<FSEntry>;
export type Show = Record<string, unknown>;
export type ShowDJ = Record<string, unknown>;
export type User = Record<string, unknown>;

export type BinEntry = {
  id: number;
  dj_id: string;
  album_id: number;
  track_title: string | null;
};
export type NewBinEntry = Omit<BinEntry, 'id'>;
export type NewShift = Record<string, unknown>;
