/**
 * Tag resolution (BS#2319 "Tags"): AzuraCast's media API when
 * `AZURACAST_API_KEY` is set, else a per-file 256KB ranged-GET ID3v2
 * fallback (`store.ts` + `id3.ts`).
 *
 * The AzuraCast response shape here is best-effort from the issue body's
 * own description ("returns artist/title/album/length/path per file") --
 * it has not been verified against a live `remote.wxyc.org` response. That
 * uncertainty is safe to ship behind, not blocking: a field AzuraCast
 * doesn't actually send just resolves to `null` here exactly like a file
 * with no ID3 tag at all, which `group.ts` already handles by reporting the
 * file ungroupable rather than misbinding it. Verify the mapping against a
 * real response (`GET /api/station/main/files`) before the first prod run
 * with `AZURACAST_API_KEY` set; see the README.
 */

import type { Id3Tags } from './id3.js';
import { parseId3v2 } from './id3.js';
import { RANGE_BYTES, rangedGet } from './store.js';
import type { S3Client } from '@aws-sdk/client-s3';

interface AzuraCastFileEntry {
  path?: string;
  artist?: string;
  title?: string;
  album?: string;
  album_artist?: string;
  track?: string | number;
  length?: number;
}

const toId3Tags = (entry: AzuraCastFileEntry): Id3Tags => ({
  title: entry.title ?? null,
  artist: entry.artist ?? null,
  album: entry.album ?? null,
  albumArtist: entry.album_artist ?? null,
  track: entry.track !== undefined ? Number.parseInt(String(entry.track), 10) || null : null,
  disc: null,
  durationMs: entry.length !== undefined ? Math.round(entry.length * 1000) : null,
});

/** `path` -> resolved tags, for every file AzuraCast's media API knows about. */
export const fetchAzuraCastTags = async (baseUrl: string, apiKey: string): Promise<Map<string, Id3Tags>> => {
  const res = await fetch(new URL('/api/station/main/files', baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`AzuraCast files API returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as AzuraCastFileEntry[];

  const map = new Map<string, Id3Tags>();
  for (const entry of body) {
    if (!entry.path) continue;
    map.set(entry.path, toId3Tags(entry));
  }
  return map;
};

/**
 * Resolve one file's tags: an AzuraCast hit wins outright; otherwise fall
 * back to the ranged-GET ID3v2 parse. `azuraCastTags === null` means the API
 * key is unset -- every file goes through the fallback.
 */
export const resolveTagsForFile = async (
  client: S3Client,
  bucket: string,
  objectKey: string,
  azuraCastTags: ReadonlyMap<string, Id3Tags> | null
): Promise<Id3Tags> => {
  const fromApi = azuraCastTags?.get(objectKey);
  if (fromApi) return fromApi;

  const buf = await rangedGet(client, bucket, objectKey, RANGE_BYTES);
  return parseId3v2(buf);
};
