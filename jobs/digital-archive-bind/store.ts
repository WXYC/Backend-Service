/**
 * Read-only DigitalOcean Spaces client (BS#2319 constraints: "Read-only
 * against the Space -- GET/LIST only; a write-capable code path must not
 * exist"). Enforced by construction, not just by convention: this file
 * imports exactly `S3Client`, `ListObjectsV2Command`, and `GetObjectCommand`
 * from `@aws-sdk/client-s3` -- no `Put*`/`Delete*`/`Copy*`/`*MultipartUpload*`
 * command is imported anywhere in this job, and
 * `tests/unit/jobs/digital-archive-bind/store.test.ts` greps this
 * file's own source for those names so a future edit can't reintroduce one
 * silently.
 *
 * S3-compatible endpoint per the issue body: `forcePathStyle: false`
 * (DigitalOcean Spaces uses virtual-hosted-style bucket addressing, unlike
 * MinIO-style path addressing).
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

export interface StoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

/**
 * `digital_asset_store.name` is `'azuracast'` (issue comment 1), so its
 * store-scoped env vars are `DIGITAL_ARCHIVE_STORE_AZURACAST_*` --
 * `WXYC/Backend-Service#2320`'s allowlist convention, which this job's
 * writer has to agree with.
 */
export const loadStoreConfigFromEnv = (): StoreConfig => ({
  endpoint: process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_ENDPOINT || 'https://nyc3.digitaloceanspaces.com',
  region: process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_REGION || 'nyc3',
  bucket: process.env.DIGITAL_ARCHIVE_STORE_AZURACAST_BUCKET || 'wxyc',
  accessKeyId: requireEnv('DIGITAL_ARCHIVE_STORE_AZURACAST_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('DIGITAL_ARCHIVE_STORE_AZURACAST_SECRET_ACCESS_KEY'),
});

export const createStoreClient = (config: StoreConfig): S3Client =>
  new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

export interface SpaceObject {
  key: string;
  bytes: number;
  /** Raw ETag, quotes included -- `md5FromETag` strips them. */
  etag: string;
}

/** Paginated `ListObjectsV2` over the whole bucket. */
export async function* listAllObjects(client: S3Client, bucket: string): AsyncGenerator<SpaceObject> {
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const obj of page.Contents ?? []) {
      if (!obj.Key) continue;
      yield { key: obj.Key, bytes: obj.Size ?? 0, etag: obj.ETag ?? '' };
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * MD5 from a single-part upload's ETag. A multipart upload's ETag has a
 * trailing `-N` part-count suffix and is NOT the object's MD5 (issue body) --
 * such an ETag is deliberately not even shaped like 32 hex chars, so the
 * regex below rejects it by construction rather than needing a separate
 * `-N` check.
 */
export const md5FromETag = (etag: string): string | null => {
  const bare = etag.replace(/^"|"$/g, '');
  return /^[a-f0-9]{32}$/i.test(bare) ? bare.toLowerCase() : null;
};

export const RANGE_BYTES = 256 * 1024;

/** The ID3v2 fallback's only network call: a ranged GET of an object's leading `RANGE_BYTES`. */
export const rangedGet = async (
  client: S3Client,
  bucket: string,
  key: string,
  byteLength: number = RANGE_BYTES
): Promise<Buffer> => {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${byteLength - 1}` }));
  const chunks: Buffer[] = [];
  const body = res.Body as AsyncIterable<Uint8Array> | undefined;
  if (body) {
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};
