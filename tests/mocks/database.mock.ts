import { jest } from '@jest/globals';

type MockQueryChain = {
  select: jest.Mock;
  selectDistinctOn: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  insert: jest.Mock;
  values: jest.Mock;
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
  legacy_release_id: 'legacy_release_id',
  on_streaming: 'on_streaming',
  artwork_url: 'artwork_url',
  artist_name: 'artist_name',
  search_doc: 'search_doc',
  canonical_entity_id: 'canonical_entity_id',
  canonical_entity_confidence: 'canonical_entity_confidence',
  canonical_entity_resolved_at: 'canonical_entity_resolved_at',
};
export const artists = {
  id: 'id',
  artist_name: 'artist_name',
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
  tracklist_lookup_attempted_at: 'tracklist_lookup_attempted_at',
};
export const library_identity = {
  library_id: 'library_id',
  discogs_release_id: 'discogs_release_id',
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
  last_modified: 'last_modified',
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
export const bins = {};
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
export const specialty_shows = {};
export const schedule = {};
export const artist_crossreference = {};
export const artist_library_crossreference = {};
export const compilation_track_artist = {
  id: 'id',
  library_id: 'library_id',
  artist_name: 'artist_name',
  track_title: 'track_title',
  track_position: 'track_position',
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

export const truncate = (value: string | null | undefined, maxLength: number): string | null => {
  if (!value || value.trim().length === 0) return null;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
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

export { requirePositiveInt, requireNonNegativeInt } from '../../shared/database/src/env-parsers.js';
export type { IntParserOptions } from '../../shared/database/src/env-parsers.js';

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
