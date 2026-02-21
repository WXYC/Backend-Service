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
export const album_metadata = {};
export const artist_metadata = {};
export const library = {};
export const artists = {};
export const genres = {};
export const format = {};
export const rotation = {};
export const library_artist_view = {};
export const flowsheet = {
  id: 'id',
  show_id: 'show_id',
  album_id: 'album_id',
  entry_type: 'entry_type',
  track_title: 'track_title',
  album_title: 'album_title',
  artist_name: 'artist_name',
  record_label: 'record_label',
  rotation_id: 'rotation_id',
  play_order: 'play_order',
  request_flag: 'request_flag',
  message: 'message',
  add_time: 'add_time',
};
export const bins = {};
export const shows = {};
export const show_djs = {};
export const user = {};
export const specialty_shows = {};

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

export type AlbumMetadata = Record<string, unknown>;
export type ArtistMetadata = Record<string, unknown>;
export type NewAlbumMetadata = Record<string, unknown>;
export type NewArtistMetadata = Record<string, unknown>;

export type FSEntry = {
  id: number;
  show_id: number | null;
  album_id: number | null;
  rotation_id: number | null;
  entry_type: string;
  track_title: string | null;
  album_title: string | null;
  artist_name: string | null;
  record_label: string | null;
  play_order: number;
  request_flag: boolean;
  message: string | null;
  add_time: Date;
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
