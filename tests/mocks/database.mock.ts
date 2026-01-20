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
    'select', 'from', 'where', 'innerJoin', 'leftJoin',
    'orderBy', 'limit', 'insert', 'values', 'update', 'set', 'delete'
  ];

  chainMethods.forEach(method => {
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
