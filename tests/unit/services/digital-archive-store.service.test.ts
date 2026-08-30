/**
 * Unit tests for the generic multi-store presigner (BS#2320).
 *
 * Mocks `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` — this is a
 * pure wiring test (env var resolution, per-store-name client caching,
 * refusal of an unconfigured store), not an integration test against a real
 * S3-compatible endpoint.
 */
import { jest } from '@jest/globals';

const mockGetSignedUrl = jest.fn<() => Promise<string>>();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const mockS3ClientCtor = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => {
    mockS3ClientCtor(config);
    return { __config: config };
  }),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ __input: input })),
}));

import { presignGet, resetClientCache } from '../../../apps/backend/services/digital-archive-store.service';

const ENV_KEYS = [
  'DIGITAL_ARCHIVE_STORE_AZURACAST_ENDPOINT',
  'DIGITAL_ARCHIVE_STORE_AZURACAST_BUCKET',
  'DIGITAL_ARCHIVE_STORE_AZURACAST_KEY_ID',
  'DIGITAL_ARCHIVE_STORE_AZURACAST_SECRET',
] as const;

describe('digital-archive-store.service presignGet', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockGetSignedUrl
      .mockReset()
      .mockResolvedValue('https://nyc3.digitaloceanspaces.com/wxyc/some-key?X-Amz-Expires=14400');
    mockS3ClientCtor.mockClear();
    resetClientCache();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const setAzuracastEnv = () => {
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_ENDPOINT = 'https://nyc3.digitaloceanspaces.com';
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_BUCKET = 'wxyc';
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_KEY_ID = 'test-key-id';
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_SECRET = 'test-secret';
  };

  it('resolves the lowercase store name "azuracast" to the uppercased env var family', async () => {
    setAzuracastEnv();
    const url = await presignGet('azuracast', 'rotation/some-file.mp3', 14400);
    expect(url).toContain('digitaloceanspaces.com');
    expect(mockS3ClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://nyc3.digitaloceanspaces.com',
        region: 'nyc3',
        credentials: { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret' },
      })
    );
  });

  it('uppercases and underscores a hyphenated store name', async () => {
    process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_ENDPOINT = 'https://example.digitaloceanspaces.com';
    process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_BUCKET = 'bucket';
    process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_KEY_ID = 'k';
    process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_SECRET = 's';
    try {
      await presignGet('some-name', 'key', 60);
      expect(mockS3ClientCtor).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: expect.stringContaining('example') })
      );
    } finally {
      delete process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_ENDPOINT;
      delete process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_BUCKET;
      delete process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_KEY_ID;
      delete process.env.DIGITAL_ARCHIVE_STORE_SOME_NAME_SECRET;
    }
  });

  it('passes ttlSeconds through as expiresIn', async () => {
    setAzuracastEnv();
    await presignGet('azuracast', 'key', 999);
    expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 999 });
  });

  it('refuses an unconfigured store name', async () => {
    await expect(presignGet('nonexistent', 'key', 60)).rejects.toThrow(/Unknown or unconfigured digital-archive store/);
  });

  it('refuses a partially-configured store (missing secret)', async () => {
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_ENDPOINT = 'https://nyc3.digitaloceanspaces.com';
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_BUCKET = 'wxyc';
    process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_KEY_ID = 'test-key-id';
    // _SECRET intentionally left unset
    await expect(presignGet('azuracast', 'key', 60)).rejects.toThrow(/Unknown or unconfigured digital-archive store/);
  });

  it('caches the S3Client per store name across calls', async () => {
    setAzuracastEnv();
    await presignGet('azuracast', 'key1', 60);
    await presignGet('azuracast', 'key2', 60);
    expect(mockS3ClientCtor).toHaveBeenCalledTimes(1);
  });
});
