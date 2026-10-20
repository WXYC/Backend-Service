/**
 * Unit tests for the instance-role S3 signing core (BS#3462, TR-X-15).
 *
 * Signs for real with a fake credential provider (no IMDS, no network): a
 * presigned URL carries its lifetime in `X-Amz-Expires` and its signer in
 * `X-Amz-Credential`, which is all these tests read back.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  createInstanceRoleSigner,
  SIGNING_REFRESH_INTERVAL_MS,
} from '../../../../apps/backend/services/s3-signing/instance-role-signer';
import {
  defineStoreAllowlist,
  undeclaredS3Imports,
} from '../../../../apps/backend/services/s3-signing/command-allowlist';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const MIN = 60_000;

const fakeCredentials = (id: string, expiresInMs?: number, now = T0) => ({
  accessKeyId: id,
  secretAccessKey: `${id}-secret`,
  sessionToken: `${id}-token`,
  ...(expiresInMs === undefined ? {} : { expiration: new Date(now + expiresInMs) }),
});

const command = () => new GetObjectCommand({ Bucket: 'bucket', Key: 'posters/a.png' });
const parse = (url: string) => {
  const q = new URL(url).searchParams;
  return { expires: Number(q.get('X-Amz-Expires')), signer: q.get('X-Amz-Credential').split('/')[0] };
};

describe('createInstanceRoleSigner', () => {
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    clock = T0;
  });

  it('resolves credentials once and reuses them across signs', async () => {
    const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 60 * MIN)));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    await signer.presign(command(), 300);
    await signer.presign(command(), 300);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('treats credentials without an expiration as non-expiring', async () => {
    const provider = jest.fn(() => Promise.resolve(fakeCredentials('A')));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    expect(parse(await signer.presign(command(), 3600)).expires).toBe(3600);
  });

  // The cache is filled at T0 with credentials of life `firstLife`; a minute later a link of `ttl`
  // seconds is signed, and any refetch returns credentials of life `freshLife`.
  it.each([
    ['fits: T + 5 min of life left', 11 * MIN, 300, 60 * MIN, 0, 'A', 300],
    ['under T + 5 min left: refreshes, fresh credentials fit', 10 * MIN, 300, 60 * MIN, 1, 'B', 300],
    [
      'fresh credentials cannot cover T + 5 min: shortened to end 1 min before expiry',
      10 * MIN,
      600,
      3 * MIN,
      1,
      'B',
      120,
    ],
  ])('%s', async (_name, firstLife, ttl, freshLife, refreshes, signedBy, expires) => {
    const provider = jest
      .fn<Promise<ReturnType<typeof fakeCredentials>>, []>()
      .mockImplementationOnce(() => Promise.resolve(fakeCredentials('A', firstLife, clock)))
      .mockImplementation(() => Promise.resolve(fakeCredentials('B', freshLife, clock)));
    const s = createInstanceRoleSigner({ credentialProvider: provider, now });
    await s.presign(command(), 1);
    clock += SIGNING_REFRESH_INTERVAL_MS;
    const url = await s.presign(command(), ttl);
    expect(provider).toHaveBeenCalledTimes(1 + refreshes);
    expect(parse(url)).toEqual({ expires, signer: signedBy });
  });

  it('fetches at most once a minute, however many near-expiry signs arrive', async () => {
    const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 3 * MIN, clock)));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    await signer.presign(command(), 600);
    await signer.presign(command(), 600);
    await signer.presign(command(), 600);
    expect(provider).toHaveBeenCalledTimes(1);
    clock += MIN;
    await signer.presign(command(), 600);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('refuses to sign when the credentials have under a minute left', async () => {
    const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 30_000)));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    await expect(signer.presign(command(), 300)).rejects.toThrow(/credentials/);
  });

  it('ignores AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment', async () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ACCESS_KEY_ID = 'SHADOW';
    process.env.AWS_SECRET_ACCESS_KEY = 'shadow-secret';
    try {
      const signer = createInstanceRoleSigner({
        credentialProvider: () => Promise.resolve(fakeCredentials('ROLE', 60 * MIN)),
        now,
      });
      expect(parse(await signer.presign(command(), 300)).signer).toBe('ROLE');
    } finally {
      for (const [name, value] of [
        ['AWS_ACCESS_KEY_ID', saved.id],
        ['AWS_SECRET_ACCESS_KEY', saved.secret],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

describe('defineStoreAllowlist', () => {
  const allowlist = defineStoreAllowlist({ commands: ['GetObjectCommand'], keyPrefixes: ['posters/'] });

  it('accepts a declared command on a declared prefix', () => {
    expect(() => allowlist.assertAllowed(command())).not.toThrow();
  });

  it.each([
    ['an undeclared command', new PutObjectCommand({ Bucket: 'b', Key: 'posters/a.png' }), /PutObjectCommand/],
    ['an undeclared key prefix', new GetObjectCommand({ Bucket: 'b', Key: 'logos/a.png' }), /prefix/],
    ['a path-traversal key', new GetObjectCommand({ Bucket: 'b', Key: 'posters/../logos/a.png' }), /prefix/],
  ])('rejects %s without echoing the key', (_name, cmd, message) => {
    expect(() => allowlist.assertAllowed(cmd)).toThrow(message);
    expect(() => allowlist.assertAllowed(cmd)).not.toThrow(/logos|a\.png/);
  });
});

describe('undeclaredS3Imports', () => {
  const declared = ['GetObjectCommand'];

  it.each([
    ["import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';", []],
    [
      "import {\n  S3Client,\n  GetObjectCommand,\n  DeleteObjectCommand,\n} from '@aws-sdk/client-s3';",
      ['DeleteObjectCommand'],
    ],
    ["import { PutObjectCommand } from '@aws-sdk/other';", []],
  ])('scans %j', (source, expected) => {
    expect(undeclaredS3Imports(source, declared)).toEqual(expected);
  });
});

describe('instance-role-signer source', () => {
  const source = readFileSync(
    path.join(__dirname, '../../../../apps/backend/services/s3-signing/instance-role-signer.ts'),
    'utf8'
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never reads an AWS_* environment variable', () => {
    expect(code).not.toMatch(/process\.env/);
  });

  it('never builds an S3 client without explicit credentials', () => {
    expect(code.match(/new S3Client\(/g)).toHaveLength(1);
    expect(code).toMatch(/new S3Client\(\{ region, credentials \}\)/);
  });

  it('imports only the presignable commands from @aws-sdk/client-s3', () => {
    expect(undeclaredS3Imports(source, ['GetObjectCommand', 'PutObjectCommand'])).toEqual([]);
  });
});
