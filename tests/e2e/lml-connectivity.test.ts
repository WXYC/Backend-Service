/**
 * Layer 2: LML Client Connectivity Tests
 *
 * Tests that directly import and call lml.client.ts functions against a running
 * library-metadata-lookup instance. No Express middleware involved.
 *
 * Prerequisites:
 * - A running LML instance (default: http://localhost:8000)
 * - Set LIBRARY_METADATA_URL env var if not using the default
 *
 * Run:
 *   LIBRARY_METADATA_URL=http://localhost:8000 npx jest --config jest.e2e.config.ts tests/e2e/lml-connectivity.test.ts
 */

import { lookupMetadata, getRelease, getArtistDetails, resolveEntity, LmlClientError } from '@wxyc/lml-client';

const LML_BASE_URL = process.env.LIBRARY_METADATA_URL || 'http://localhost:8000';

let lmlReachable = false;

beforeAll(async () => {
  // Ensure the env var is set so the client can find the service
  if (!process.env.LIBRARY_METADATA_URL) {
    process.env.LIBRARY_METADATA_URL = LML_BASE_URL;
  }

  // Probe the health endpoint to determine if LML is available.
  // LML returns 503 when the library DB is missing but Discogs endpoints
  // still work, so any HTTP response means the service is reachable.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${LML_BASE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    lmlReachable = response.status > 0;
  } catch {
    lmlReachable = false;
  }
});

function skipIfUnreachable() {
  if (!lmlReachable) {
    console.warn(`Skipping test: LML is not reachable at ${LML_BASE_URL}`);
  }
}

describe('LML Client Connectivity', () => {
  describe('Health Check', () => {
    test('LML service is reachable', async () => {
      const response = await fetch(`${LML_BASE_URL}/health`);
      // 200 = healthy/degraded, 503 = unhealthy (e.g., library DB missing).
      // Either means the service is running; Discogs endpoints work regardless.
      expect([200, 503]).toContain(response.status);
      const body = (await response.json()) as { status: string };
      expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    });
  });

  describe('Release', () => {
    beforeEach(() => skipIfUnreachable());

    test('returns metadata for known release ID', async () => {
      if (!lmlReachable) return;

      // Dots and Loops by Stereolab (Discogs release 90416)
      const release = await getRelease(90416);
      expect(release.title).toContain('Dots');
      expect(release.tracklist.length).toBeGreaterThan(0);
      expect(release.release_url).toContain('90416');
    });
  });

  describe('Artist', () => {
    beforeEach(() => skipIfUnreachable());

    test('returns details for known artist ID', async () => {
      if (!lmlReachable) return;

      // Stereolab (Discogs artist 388)
      const artist = await getArtistDetails(388);
      expect(artist.name).toBe('Stereolab');
      expect(artist.artist_id).toBe(388);
      expect(typeof artist.profile).toBe('string');
    });

    test('throws for nonexistent artist', async () => {
      if (!lmlReachable) return;

      await expect(getArtistDetails(999999999)).rejects.toThrow(LmlClientError);
      await expect(getArtistDetails(999999999)).rejects.toMatchObject({
        statusCode: expect.any(Number),
      });
    });
  });

  describe('Entity Resolution', () => {
    beforeEach(() => skipIfUnreachable());

    test('resolves artist entity', async () => {
      if (!lmlReachable) return;

      const entity = await resolveEntity('artist', 388);
      expect(entity.name).toBe('Stereolab');
      expect(entity.type).toBe('artist');
      expect(entity.id).toBe(388);
    });
  });

  describe('Error Handling', () => {
    test('throws LmlClientError with 502 when LML is unreachable', async () => {
      const original = process.env.LIBRARY_METADATA_URL;
      process.env.LIBRARY_METADATA_URL = 'http://localhost:59999';
      try {
        await expect(lookupMetadata('test')).rejects.toThrow(LmlClientError);
        await expect(lookupMetadata('test')).rejects.toMatchObject({
          statusCode: 502,
        });
      } finally {
        process.env.LIBRARY_METADATA_URL = original;
      }
    });

    test('throws LmlClientError with 503 when LIBRARY_METADATA_URL is unset', async () => {
      const original = process.env.LIBRARY_METADATA_URL;
      delete process.env.LIBRARY_METADATA_URL;
      try {
        await expect(lookupMetadata('test')).rejects.toThrow(LmlClientError);
        await expect(lookupMetadata('test')).rejects.toMatchObject({
          statusCode: 503,
        });
      } finally {
        process.env.LIBRARY_METADATA_URL = original;
      }
    });
  });
});
