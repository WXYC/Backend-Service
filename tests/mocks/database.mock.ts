import { jest } from '@jest/globals';

type MockQueryChain = {
  select: jest.Mock;
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
  return {
    select: mockChain.select,
    insert: mockChain.insert,
    update: mockChain.update,
    delete: mockChain.delete,
    execute: mockChain.execute,
    _chain: mockChain,
  };
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
};
export const artists = {};
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
};
export const library_artist_view = {};
export const flowsheet = {
  id: 'id',
  show_id: 'show_id',
  album_id: 'album_id',
  legacy_entry_id: 'legacy_entry_id',
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
};
export const bins = {};
export const shows = {};
export const show_djs = {};
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
export const specialty_shows = {};
export const schedule = {};
export const artist_crossreference = {};
export const artist_library_crossreference = {};

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
