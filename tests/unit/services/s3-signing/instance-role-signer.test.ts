/**
 * Unit tests for the instance-role S3 signing core (BS#3462, TR-X-15).
 *
 * Signs for real with a fake credential provider (no IMDS, no network): a
 * presigned URL carries its lifetime in `X-Amz-Expires` and its signer in
 * `X-Amz-Credential`, which is all these tests read back.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CREDENTIAL_FAILURE_BACKOFF_MS,
  createInstanceRoleSigner,
  SIGNING_REFRESH_INTERVAL_MS,
} from '../../../../apps/backend/services/s3-signing/instance-role-signer';
import {
  defineStoreAllowlist,
  undeclaredImports,
  undeclaredS3Imports,
} from '../../../../apps/backend/services/s3-signing/command-allowlist';

const mockFromInstanceMetadata = jest.fn();
jest.mock('@aws-sdk/credential-providers', () => ({
  fromInstanceMetadata: (...args: unknown[]) => mockFromInstanceMetadata(...args),
}));

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

  it('sizes links against originalExpiration when the SDK static-stability fallback rewrote expiration', async () => {
    // Shape from @smithy/credential-provider-imds after a failed refresh: expiration is now + 5-10 min, the real value is kept.
    const provider = jest.fn(() =>
      Promise.resolve({
        ...fakeCredentials('A', 8 * MIN, clock),
        originalExpiration: new Date(clock + 3 * MIN),
      })
    );
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    expect(parse(await signer.presign(command(), 600)).expires).toBe(120);
  });

  it('uses the default provider fromInstanceMetadata with the IMDS budget, not the default chain', async () => {
    mockFromInstanceMetadata.mockReturnValue(() => Promise.resolve(fakeCredentials('IMDS', 60 * MIN)));
    const signer = createInstanceRoleSigner({ now });
    expect(parse(await signer.presign(command(), 300)).signer).toBe('IMDS');
    expect(mockFromInstanceMetadata).toHaveBeenCalledWith({ timeout: 1000, maxRetries: 0 });
  });

  it.each([[NaN], [0], [-5], [1.5], [Infinity]])('rejects expiresInSeconds %p', async (ttl) => {
    const signer = createInstanceRoleSigner({
      credentialProvider: () => Promise.resolve(fakeCredentials('A', 60 * MIN)),
      now,
    });
    await expect(signer.presign(command(), ttl)).rejects.toThrow(/expiresInSeconds/);
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
  it('shares one in-flight credential fetch between concurrent presigns on an empty cache', async () => {
    let resolve!: (c: ReturnType<typeof fakeCredentials>) => void;
    const provider = jest.fn(() => new Promise<ReturnType<typeof fakeCredentials>>((r) => (resolve = r)));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    const both = Promise.all([signer.presign(command(), 300), signer.presign(command(), 300)]);
    await Promise.resolve();
    resolve(fakeCredentials('A', 60 * MIN));
    await both;
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failed fetch, then retries', async () => {
    const provider = jest
      .fn<Promise<ReturnType<typeof fakeCredentials>>, []>()
      .mockRejectedValueOnce(new Error('imds down'))
      .mockResolvedValue(fakeCredentials('A', 60 * MIN));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    await expect(signer.presign(command(), 300)).rejects.toThrow('imds down');
    await expect(signer.presign(command(), 300)).rejects.toThrow('imds down');
    expect(provider).toHaveBeenCalledTimes(1);
    clock += CREDENTIAL_FAILURE_BACKOFF_MS;
    await expect(signer.presign(command(), 300)).resolves.toContain('X-Amz-Signature');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  describe('send', () => {
    it('signs server-side calls with the resolved instance-role credentials, never the default chain', async () => {
      const saved = process.env.AWS_ACCESS_KEY_ID;
      process.env.AWS_ACCESS_KEY_ID = 'SHADOW';
      const { S3Client } = jest.requireActual('@aws-sdk/client-s3');
      const spy = jest.spyOn(S3Client.prototype, 'send').mockImplementation(async function (this: {
        config: { credentials: () => Promise<{ accessKeyId: string }> };
      }) {
        return { signedBy: (await this.config.credentials()).accessKeyId };
      });
      try {
        const provider = jest.fn(() => Promise.resolve(fakeCredentials('ROLE', 60 * MIN)));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        await expect(signer.send(new HeadObjectCommand({ Bucket: 'b', Key: 'posters/a.png' }))).resolves.toEqual({
          signedBy: 'ROLE',
        });
      } finally {
        spy.mockRestore();
        if (saved === undefined) {
          delete process.env.AWS_ACCESS_KEY_ID;
        } else {
          process.env.AWS_ACCESS_KEY_ID = saved;
        }
      }
    });

    it('forwards send options to the client', async () => {
      const { S3Client } = jest.requireActual('@aws-sdk/client-s3');
      const spy = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({});
      try {
        const signer = createInstanceRoleSigner({
          credentialProvider: () => Promise.resolve(fakeCredentials('A', 60 * MIN)),
          now,
        });
        const cmd = new HeadObjectCommand({ Bucket: 'b', Key: 'posters/a.png' });
        const options = { abortSignal: new AbortController().signal };
        await signer.send(cmd, options);
        expect(spy).toHaveBeenCalledWith(cmd, options);
      } finally {
        spy.mockRestore();
      }
    });

    it('reuses the cached credentials across sends and presigns, refreshing at most once a minute', async () => {
      const { S3Client } = jest.requireActual('@aws-sdk/client-s3');
      const spy = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({});
      try {
        const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 3 * MIN, clock)));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        await signer.send(new HeadObjectCommand({ Bucket: 'b', Key: 'posters/a.png' }));
        await signer.send(new HeadObjectCommand({ Bucket: 'b', Key: 'posters/a.png' }));
        expect(provider).toHaveBeenCalledTimes(1);
        clock += MIN;
        await signer.send(new HeadObjectCommand({ Bucket: 'b', Key: 'posters/a.png' }));
        expect(provider).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    describe('client lifecycle and failures', () => {
      const { S3Client } = jest.requireActual('@aws-sdk/client-s3');
      const head = () => new HeadObjectCommand({ Bucket: 'b', Key: 'posters/a.png' });
      let sendSpy: jest.SpyInstance;
      let destroySpy: jest.SpyInstance;
      beforeEach(() => {
        sendSpy = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({});
        destroySpy = jest.spyOn(S3Client.prototype, 'destroy').mockImplementation(() => undefined);
      });
      afterEach(() => {
        sendSpy.mockRestore();
        destroySpy.mockRestore();
      });

      it('destroys the replaced client when credentials are refetched', async () => {
        const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 3 * MIN, clock)));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        await signer.send(head());
        expect(destroySpy).not.toHaveBeenCalled();
        clock += MIN;
        await signer.send(head());
        expect(provider).toHaveBeenCalledTimes(2);
        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(destroySpy.mock.instances[0]).toBe(sendSpy.mock.instances[0]);
      });

      it('defers destroying the replaced client until its in-flight sends finish', async () => {
        let finish!: () => void;
        sendSpy.mockImplementationOnce(() => new Promise((r) => (finish = () => r({}))));
        const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 3 * MIN, clock)));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        const slow = signer.send(head());
        await new Promise((r) => setImmediate(r));
        clock += MIN;
        await signer.send(head());
        expect(destroySpy).not.toHaveBeenCalled();
        finish();
        await slow;
        expect(destroySpy).toHaveBeenCalledTimes(1);
      });

      it('delivers a credential-fetch failure to the callback form without an unhandled rejection', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try {
          const signer = createInstanceRoleSigner({
            credentialProvider: () => Promise.reject(new Error('imds down')),
            now,
          });
          const err = await new Promise<Error>((resolve) => {
            (signer.send as (c: unknown, cb: (e: Error) => void) => void)(head(), resolve);
          });
          expect(err.message).toBe('imds down');
          await new Promise((r) => setImmediate(r));
          expect(rejections).toEqual([]);
        } finally {
          process.off('unhandledRejection', onRejection);
        }
      });

      it('does not raise an unhandled rejection when the callback itself throws', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try {
          const signer = createInstanceRoleSigner({
            credentialProvider: () => Promise.resolve(fakeCredentials('A', 3 * MIN, clock)),
            now,
          });
          let called = false;
          (signer.send as (c: unknown, cb: () => void) => void)(head(), () => {
            called = true;
            throw new Error('callback boom');
          });
          await new Promise((r) => setTimeout(r, 20));
          expect(called).toBe(true);
          expect(rejections).toEqual([]);
        } finally {
          process.off('unhandledRejection', onRejection);
        }
      });

      it('keeps using still-valid cached credentials when a refetch fails, through the back-off', async () => {
        const provider = jest
          .fn<Promise<ReturnType<typeof fakeCredentials>>, []>()
          .mockResolvedValueOnce(fakeCredentials('A', 4 * MIN, clock))
          .mockRejectedValue(new Error('imds down'));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        await signer.send(head());
        clock += MIN;
        await expect(signer.send(head())).resolves.toEqual({});
        await expect(signer.send(head())).resolves.toEqual({});
        await expect(signer.credentials()).resolves.toMatchObject({ accessKeyId: 'A' });
        expect(provider).toHaveBeenCalledTimes(2);
      });

      it('refuses to send with expired credentials, surfacing the fetch failure', async () => {
        const provider = jest
          .fn<Promise<ReturnType<typeof fakeCredentials>>, []>()
          .mockResolvedValueOnce(fakeCredentials('A', 4 * MIN, clock))
          .mockRejectedValue(new Error('imds down'));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        await signer.send(head());
        clock += 5 * MIN;
        await expect(signer.send(head())).rejects.toThrow('imds down');
        expect(sendSpy).toHaveBeenCalledTimes(1);
      });

      it('refuses to send with credentials that arrive already expired', async () => {
        const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', -1000, clock)));
        const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
        await expect(signer.send(head())).rejects.toThrow(/expired/);
        expect(sendSpy).not.toHaveBeenCalled();
      });
    });
  });

  it('hands out the same cached credentials through credentials()', async () => {
    const provider = jest.fn(() => Promise.resolve(fakeCredentials('A', 60 * MIN)));
    const signer = createInstanceRoleSigner({ credentialProvider: provider, now });
    await signer.presign(command(), 300);
    await expect(signer.credentials()).resolves.toMatchObject({ accessKeyId: 'A' });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('defineStoreAllowlist', () => {
  const allowlist = defineStoreAllowlist({
    commands: ['GetObjectCommand', 'CopyObjectCommand'],
    keyPrefixes: ['posters/'],
  });

  it('accepts a declared command on a declared prefix', () => {
    expect(() => allowlist.assertAllowed(command())).not.toThrow();
  });

  it.each([[''], ['posters']])('refuses to define a store with key prefix %j', (prefix) => {
    expect(() => defineStoreAllowlist({ commands: ['GetObjectCommand'], keyPrefixes: [prefix] })).toThrow(/prefix/);
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

describe('defineStoreAllowlist CreateInvalidationCommand', () => {
  const allowlist = defineStoreAllowlist({ commands: ['CreateInvalidationCommand'], keyPrefixes: ['p/'] });
  // Stands in for the CloudFront command class: the allowlist reads only its name and input.
  class CreateInvalidationCommand {
    constructor(public input: { InvalidationBatch: { Paths: { Items?: string[] } } }) {}
  }
  const invalidate = (Items?: string[]) => new CreateInvalidationCommand({ InvalidationBatch: { Paths: { Items } } });

  it.each([
    ['a path under the prefix', ['/p/abc.jpg']],
    ['a wildcard at the prefix directory', ['/p/*']],
    ['several allowed paths', ['/p/a.jpg', '/p/b/*']],
    ['an encoded character that stays under the prefix', ['/p/a%20b.jpg']],
  ])('allows %s', (_name, items) => {
    expect(() => allowlist.assertAllowed(invalidate(items))).not.toThrow();
  });

  it.each([
    ['a path outside the prefix', ['/held/x']],
    ['a root wildcard', ['/*']],
    ['a wildcard that widens the prefix', ['/p*']],
    ['a path-traversal path', ['/p/../held/x']],
    ['an encoded-slash traversal path', ['/p/..%2Fheld/x']],
    ['an encoded-dot traversal path', ['/p/%2E%2E/held/x']],
    ['an encoded prefix escape', ['/p%2F..%2Fheld/x']],
    ['a malformed encoding', ['/p/%E0%A4%A.jpg']],
    ['an empty path', ['']],
    ['an empty Items list', []],
    ['a missing Items list', undefined],
    ['a mixed list with one bad path', ['/p/a.jpg', '/held/x']],
  ])('refuses %s without echoing the path', (_name, items) => {
    expect(() => allowlist.assertAllowed(invalidate(items))).toThrow(/invalidation/i);
    expect(() => allowlist.assertAllowed(invalidate(items))).not.toThrow(/held|a\.jpg/);
  });

  it('fails closed for another keyless command', () => {
    class ListObjectsV2Command {
      input = {};
    }
    const open = defineStoreAllowlist({ commands: ['ListObjectsV2Command'], keyPrefixes: ['p/'] });
    expect(() => open.assertAllowed(new ListObjectsV2Command())).toThrow(/prefix/);
  });
});

describe('defineStoreAllowlist CopySource', () => {
  const allowlist = defineStoreAllowlist({ commands: ['CopyObjectCommand'], keyPrefixes: ['posters/', 'held/'] });
  const copy = (CopySource: string) => new CopyObjectCommand({ Bucket: 'b', Key: 'posters/dest.png', CopySource });

  it.each([
    ['an allowed prefix', 'b/held/a.png'],
    ['an allowed prefix with a leading slash', '/b/held/a.png'],
    ['an allowed prefix with a version id', 'b/held/a.png?versionId=3'],
  ])('accepts %s', (_name, source) => {
    expect(() => allowlist.assertAllowed(copy(source))).not.toThrow();
  });

  it('refuses a copy source when the command has no Bucket', () => {
    const noBucket = (CopySource: string) => new CopyObjectCommand({ Key: 'posters/dest.png', CopySource } as never);
    expect(() => allowlist.assertAllowed(noBucket('other/held/a.png'))).toThrow(/bucket/);
    expect(() => allowlist.assertAllowed(noBucket('b/held/a.png'))).toThrow(/bucket/);
    expect(() => allowlist.assertAllowed(noBucket('b/logos/a.png'))).toThrow();
  });

  it.each([
    ['another prefix', 'b/logos/a.png', /prefix/],
    ['a path-traversal source', 'b/held/../logos/a.png', /prefix/],
    ['an encoded path-traversal source', 'b/held/%2E%2E/logos/a.png', /prefix/],
    ['an encoded-slash traversal source', 'b/held/..%2Flogos/a.png', /prefix/],
    ['a malformed encoding', 'b/held/%E0%A4%A.png', /prefix/],
    ['another bucket', 'other/held/a.png', /bucket/],
    ['an encoded-slash traversal', 'b/held%2F..%2Flogos/a.png', /prefix/],
    ['a double leading slash', '//b/held/a.png', /bucket/],
  ])('rejects %s without echoing the source', (_name, source, message) => {
    expect(() => allowlist.assertAllowed(copy(source))).toThrow(message);
    expect(() => allowlist.assertAllowed(copy(source))).not.toThrow(/logos|other|a\.png/);
  });
});

describe('undeclaredImports', () => {
  const cloudfront = '@aws-sdk/client-cloudfront';

  it('finds an undeclared client-cloudfront command and exempts its client', () => {
    const source =
      "import { CloudFrontClient, CreateInvalidationCommand, DeleteDistributionCommand } from '@aws-sdk/client-cloudfront';";
    expect(undeclaredImports(source, cloudfront, ['CreateInvalidationCommand'])).toEqual(['DeleteDistributionCommand']);
  });

  it('ignores imports from other packages', () => {
    const source = "import { DeleteObjectCommand } from '@aws-sdk/client-s3';";
    expect(undeclaredImports(source, cloudfront, [])).toEqual([]);
  });

  it.each([
    ['a namespace import', "import * as cf from '@aws-sdk/client-cloudfront';", ['*']],
    ['a double-quoted namespace import', 'import * as cf from "@aws-sdk/client-cloudfront";', ['*']],
    [
      'a double-quoted named import',
      'import { DeleteDistributionCommand } from "@aws-sdk/client-cloudfront";',
      ['DeleteDistributionCommand'],
    ],
    ['a default import', "import cf from '@aws-sdk/client-cloudfront';", ['default']],
    [
      'a default import beside named imports',
      "import cf, { DeleteDistributionCommand } from '@aws-sdk/client-cloudfront';",
      ['default', 'DeleteDistributionCommand'],
    ],
    ['a default import beside a namespace', "import cf, * as all from '@aws-sdk/client-cloudfront';", ['default', '*']],
    [
      'a renamed import, by its original name',
      "import { DeleteDistributionCommand as Del } from '@aws-sdk/client-cloudfront';",
      ['DeleteDistributionCommand'],
    ],
    [
      'an inline type modifier',
      "import { type DeleteDistributionCommand } from '@aws-sdk/client-cloudfront';",
      ['DeleteDistributionCommand'],
    ],
    [
      'a named re-export',
      "export { DeleteDistributionCommand } from '@aws-sdk/client-cloudfront';",
      ['DeleteDistributionCommand'],
    ],
    ['a star re-export', "export * from '@aws-sdk/client-cloudfront';", ['*']],
    ['a namespace re-export', "export * as cf from '@aws-sdk/client-cloudfront';", ['*']],
    [
      'a multi-line re-export',
      "export {\n  CreateInvalidationCommand,\n  DeleteDistributionCommand,\n} from '@aws-sdk/client-cloudfront';",
      ['DeleteDistributionCommand'],
    ],
    ['a require call', "const cf = require('@aws-sdk/client-cloudfront');", ["require('@aws-sdk/client-cloudfront')"]],
    [
      'a double-quoted require call',
      'const cf = require("@aws-sdk/client-cloudfront");',
      ["require('@aws-sdk/client-cloudfront')"],
    ],
    [
      'a dynamic import',
      "const cf = await import('@aws-sdk/client-cloudfront');",
      ["import('@aws-sdk/client-cloudfront')"],
    ],
    [
      'a double-quoted dynamic import',
      'const cf = await import( "@aws-sdk/client-cloudfront" );',
      ["import('@aws-sdk/client-cloudfront')"],
    ],
    ['a computed require specifier', 'const cf = require(name);', ['require(<computed>)']],
    [
      'a concatenated require specifier',
      "const cf = require('@aws-sdk/client-' + 'cloudfront');",
      ['require(<computed>)'],
    ],
    ['a computed dynamic import specifier', 'const cf = await import(`@aws-sdk/${name}`);', ['import(<computed>)']],
  ])('reports %s as undeclared', (_name, source, expected) => {
    expect(undeclaredImports(source, cloudfront, ['CreateInvalidationCommand'])).toEqual(expected);
  });

  it.each([
    [
      'declared named imports',
      "import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';",
    ],
    ['a type-only import', "import type { DeleteDistributionCommand } from '@aws-sdk/client-cloudfront';"],
    ['a type-only default import', "import type Cf from '@aws-sdk/client-cloudfront';"],
    ['a side-effect import', "import '@aws-sdk/client-cloudfront';"],
    ['a require of another package', "const s3 = require('@aws-sdk/client-s3');"],
    ['a dynamic import of another package', "const s3 = await import('@aws-sdk/client-s3');"],
    ['a method that happens to be named require', 'loader.require(name);'],
  ])('passes %s', (_name, source) => {
    expect(undeclaredImports(source, cloudfront, ['CreateInvalidationCommand'])).toEqual([]);
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
