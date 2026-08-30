/**
 * Generic multi-store presigner (BS#2320, epic WXYC/wxyc-dj-ios#135).
 *
 * `presignGet(storeName, key, ttlSeconds)` mints a time-limited GET URL for an
 * object in a `digital_asset_store` row, resolving the endpoint / region /
 * bucket / credentials for that store name from env vars named
 * `DIGITAL_ARCHIVE_STORE_<NAME>_ENDPOINT` / `_BUCKET` / `_KEY_ID` / `_SECRET`.
 * `<NAME>` is the store's `name` column UPPERCASED with `-` turned into `_`
 * (done explicitly here, not left as an implicit convention) — today's only
 * row is `azuracast`, so `DIGITAL_ARCHIVE_STORE_AZURACAST_*`.
 *
 * Deliberately store-name-keyed rather than a single hardcoded S3 client:
 * this is the abstraction the horizontal-auth Track G migration (the
 * broadcast archive's own signer) is meant to reuse for a second store
 * without touching this module.
 *
 * The store's key is READ-ONLY by design (a leaked signer key can only
 * presign GETs against buckets it's scoped to) — this module never
 * constructs a PUT/DELETE command. In-org precedent:
 * `archive/app/api/signed-url/route.ts`.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** `azuracast` -> `AZURACAST`; `some-name` -> `SOME_NAME`. */
const envNameFor = (storeName: string): string => storeName.toUpperCase().replace(/-/g, '_');

type StoreEnvConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Reads the four `DIGITAL_ARCHIVE_STORE_<NAME>_*` env vars for a store name.
 * Region is not separately configured — `s3-request-presigner` only uses it
 * to shape the signature, and DigitalOcean Spaces (today's only backend)
 * takes the region from the endpoint's subdomain, so it is derived here
 * rather than adding a fifth env var per store. Throws (refuses the unknown
 * store) when any of the four required vars is absent, so a typo'd or
 * unconfigured store name fails loudly at call time rather than presigning
 * against `undefined`.
 */
function readStoreEnvConfig(storeName: string): StoreEnvConfig {
  const envName = envNameFor(storeName);
  const endpoint = process.env[`DIGITAL_ARCHIVE_STORE_${envName}_ENDPOINT`];
  const bucket = process.env[`DIGITAL_ARCHIVE_STORE_${envName}_BUCKET`];
  const accessKeyId = process.env[`DIGITAL_ARCHIVE_STORE_${envName}_KEY_ID`];
  const secretAccessKey = process.env[`DIGITAL_ARCHIVE_STORE_${envName}_SECRET`];

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `Unknown or unconfigured digital-archive store "${storeName}": missing one or more of ` +
        `DIGITAL_ARCHIVE_STORE_${envName}_ENDPOINT / _BUCKET / _KEY_ID / _SECRET.`
    );
  }

  // DigitalOcean Spaces endpoints are `https://<region>.digitaloceanspaces.com`
  // — the region the SDK needs for SigV4 is exactly that first host label.
  // Falls back to the literal `us-east-1` default other AWS-compatible
  // endpoints expect when the host shape doesn't match, rather than throwing:
  // region only affects the signature, not which bucket is hit.
  const region = new URL(endpoint).hostname.split('.')[0] || 'us-east-1';

  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

const clientsByStore = new Map<string, S3Client>();

function getClient(storeName: string, config: StoreEnvConfig): S3Client {
  const cached = clientsByStore.get(storeName);
  if (cached) return cached;

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  clientsByStore.set(storeName, client);
  return client;
}

/**
 * Mints a presigned GET URL for `key` in `storeName`'s bucket, valid for
 * `ttlSeconds`. Never logs the returned URL or any credential — the URL is a
 * bearer credential until it expires (see `digital-archive.service.ts`).
 */
export async function presignGet(storeName: string, key: string, ttlSeconds: number): Promise<string> {
  const config = readStoreEnvConfig(storeName);
  const client = getClient(storeName, config);
  const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: ttlSeconds });
}

/** Test-only: drop cached clients so a test can reconfigure store env vars. */
export function resetClientCache(): void {
  clientsByStore.clear();
}
