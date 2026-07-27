/**
 * Manifest download for album-critic-reviews-etl (BS#1830): the
 * `manifest-latest` release's `manifest.jsonl.gz` asset from the PRIVATE
 * `WXYC/research-data` repo, via GitHub's REST API — no LFS, no repo clone.
 *
 * Two calls:
 *   1. `GET /repos/{owner}/{repo}/releases/tags/{tag}` to find the asset's
 *      API url (the asset's `url` field — NOT `browser_download_url`, which
 *      redirects to a signed S3 URL that a private-repo download can't
 *      reach without going through the API auth first).
 *   2. `GET` that asset url with `Accept: application/octet-stream`, which
 *      GitHub's API serves as raw bytes directly (not a redirect) when the
 *      requester is authenticated for a private repo.
 *
 * Deliberately no transient-fetch retry here — see the plan's "Key design
 * decisions" #2: the donor's `withSheetRetry` (BS#1692) was a later
 * hardening pass on `album-reviews-etl`, not part of its original shape,
 * and a failed weekly run costs nothing to re-trigger manually or simply
 * wait a week for.
 *
 * `owner`/`repo`/`tag`/`asset name` are a fixed cross-repo contract, not
 * env-configurable — only the token is a secret.
 */
import { gunzipSync } from 'node:zlib';

export const RESEARCH_DATA_OWNER = 'WXYC';
export const RESEARCH_DATA_REPO = 'research-data';
export const MANIFEST_RELEASE_TAG = 'manifest-latest';
export const MANIFEST_ASSET_NAME = 'manifest.jsonl.gz';
const USER_AGENT = 'wxyc-album-critic-reviews-etl';

export const resolveResearchDataToken = (raw: string | undefined = process.env.RESEARCH_DATA_TOKEN): string => {
  if (!raw) {
    throw new Error(
      'RESEARCH_DATA_TOKEN is required (read-only token for the private WXYC/research-data repo, used to fetch the manifest-latest release asset)'
    );
  }
  return raw;
};

interface GithubReleaseAsset {
  name: string;
  url: string;
}

interface GithubRelease {
  assets?: GithubReleaseAsset[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Download the `manifest.jsonl.gz` release asset as a gzipped Buffer.
 *  `fetchFn` defaults to the global `fetch` (Node 24 native); tests inject
 *  a fake to avoid a real network call. */
export const fetchManifestAsset = async (token: string, fetchFn: FetchFn = fetch): Promise<Buffer> => {
  const releaseUrl = `https://api.github.com/repos/${RESEARCH_DATA_OWNER}/${RESEARCH_DATA_REPO}/releases/tags/${MANIFEST_RELEASE_TAG}`;
  const releaseResp = await fetchFn(releaseUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!releaseResp.ok) {
    throw new Error(
      `GitHub release lookup for ${MANIFEST_RELEASE_TAG} failed: ${releaseResp.status} ${releaseResp.statusText}`
    );
  }
  const release = (await releaseResp.json()) as GithubRelease;
  const asset = (release.assets ?? []).find((a) => a.name === MANIFEST_ASSET_NAME);
  if (!asset) {
    throw new Error(`release ${MANIFEST_RELEASE_TAG} has no asset named ${MANIFEST_ASSET_NAME}`);
  }

  const assetResp = await fetchFn(asset.url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/octet-stream',
      'User-Agent': USER_AGENT,
    },
  });
  if (!assetResp.ok) {
    throw new Error(
      `GitHub asset download for ${MANIFEST_ASSET_NAME} failed: ${assetResp.status} ${assetResp.statusText}`
    );
  }
  return Buffer.from(await assetResp.arrayBuffer());
};

export const gunzipManifest = (gz: Buffer): string => gunzipSync(gz).toString('utf8');
