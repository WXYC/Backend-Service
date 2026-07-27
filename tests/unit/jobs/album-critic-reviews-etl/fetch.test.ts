/**
 * Unit tests for album-critic-reviews-etl's fetch.ts (BS#1830): manifest
 * download from the private WXYC/research-data repo's `manifest-latest`
 * release. `fetchManifestAsset` takes an injectable `fetch`-shaped function
 * so no real network call is made; verifies the two-call sequence (release
 * lookup by tag, then asset download via the asset's API `url` with
 * `Accept: application/octet-stream` — NOT `browser_download_url`, which
 * doesn't work for a private repo without a signed redirect).
 */
import { gzipSync } from 'node:zlib';
import {
  resolveResearchDataToken,
  fetchManifestAsset,
  gunzipManifest,
  RESEARCH_DATA_OWNER,
  RESEARCH_DATA_REPO,
  MANIFEST_RELEASE_TAG,
  MANIFEST_ASSET_NAME,
} from '../../../../jobs/album-critic-reviews-etl/fetch';

describe('resolveResearchDataToken', () => {
  it('throws when unset', () => {
    expect(() => resolveResearchDataToken(undefined)).toThrow(/RESEARCH_DATA_TOKEN/);
  });

  it('returns the token when set', () => {
    expect(resolveResearchDataToken('ghp_abc123')).toBe('ghp_abc123');
  });
});

describe('gunzipManifest', () => {
  it('round-trips a gzipped buffer back to its original text', () => {
    const original = 'line one\nline two\n';
    const gz = gzipSync(Buffer.from(original, 'utf8'));
    expect(gunzipManifest(gz)).toBe(original);
  });
});

describe('fetchManifestAsset', () => {
  const assetUrl = `https://api.github.com/repos/${RESEARCH_DATA_OWNER}/${RESEARCH_DATA_REPO}/releases/assets/999`;
  const gzBytes = gzipSync(Buffer.from('manifest body', 'utf8'));

  const okRelease = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ assets: [{ name: MANIFEST_ASSET_NAME, url: assetUrl }] }),
    } as unknown as Response);

  const okAsset = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: () =>
        Promise.resolve(gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength)),
    } as unknown as Response);

  it('looks up the release by tag, then downloads the asset via its API url with Accept: application/octet-stream', async () => {
    const fetchFn = jest.fn().mockImplementationOnce(okRelease).mockImplementationOnce(okAsset);

    const result = await fetchManifestAsset('token123', fetchFn);
    expect(Buffer.compare(result, Buffer.from(gzBytes))).toBe(0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [releaseUrl, releaseInit] = fetchFn.mock.calls[0];
    expect(releaseUrl).toBe(
      `https://api.github.com/repos/${RESEARCH_DATA_OWNER}/${RESEARCH_DATA_REPO}/releases/tags/${MANIFEST_RELEASE_TAG}`
    );
    expect((releaseInit.headers as Record<string, string>).Authorization).toBe('Bearer token123');

    const [downloadUrl, downloadInit] = fetchFn.mock.calls[1];
    expect(downloadUrl).toBe(assetUrl);
    expect((downloadInit.headers as Record<string, string>).Accept).toBe('application/octet-stream');
    expect((downloadInit.headers as Record<string, string>).Authorization).toBe('Bearer token123');
  });

  it('throws when the release lookup responds non-ok', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchManifestAsset('token123', fetchFn)).rejects.toThrow(/release lookup/i);
  });

  it('throws when the release has no matching asset', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ assets: [{ name: 'something-else.txt', url: 'https://x' }] }),
    });
    await expect(fetchManifestAsset('token123', fetchFn)).rejects.toThrow(/no asset named/i);
  });

  it('throws when the asset download responds non-ok', async () => {
    const fetchFn = jest
      .fn()
      .mockImplementationOnce(okRelease)
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
    await expect(fetchManifestAsset('token123', fetchFn)).rejects.toThrow(/asset download/i);
  });
});
