/**
 * The CloudWatch credential provider is pinned to the EC2 instance role
 * (BS#2533).
 *
 * BS#2518 is the incident this pins shut: a single-purpose SES credential
 * living under the reserved `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
 * names outranked the `wxyc-ec2-backend` instance role in the SDK's default
 * chain, and `WXYC/BackendService` did not exist as a CloudWatch namespace
 * for 105 days. BS#2530 added detection; this suite pins the structural fix.
 *
 * The assertion that matters is behavioural, not shape-level. "A `credentials`
 * key was passed" would also pass against a client that still honoured the
 * env vars, so the headline test sets `AWS_ACCESS_KEY_ID` to an impostor
 * value, resolves the provider the client was actually constructed with
 * against a fake IMDS on loopback, and asserts the identity that comes back
 * is the instance role's — not the env var's. Against the unpinned code
 * (`new CloudWatchClient({ region })`) `config.credentials` is `undefined`
 * and the resolution throws, so this suite goes red the moment the pin is
 * removed.
 *
 * The fake IMDS is a loopback `http.Server` addressed via
 * `AWS_EC2_METADATA_SERVICE_ENDPOINT`; nothing here touches 169.254.169.254
 * or any network beyond 127.0.0.1.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';

interface CapturedClientConfig {
  region?: string;
  credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
}

const capturedConfigs: CapturedClientConfig[] = [];
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation((config: CapturedClientConfig) => {
    capturedConfigs.push(config);
    return { send: mockSend };
  }),
  PutMetricDataCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { createBufferedMetricEmitter, createCloudWatchClient } from '@wxyc/observability/metrics';

const INSTANCE_ROLE = 'wxyc-ec2-backend';
const INSTANCE_ROLE_ACCESS_KEY_ID = 'ASIAWXYCINSTANCEROLE';
const IMPOSTOR_ACCESS_KEY_ID = 'AKIAIMPOSTORSESKEY';

/**
 * Minimal IMDSv2 surface: the token PUT, the role listing, and the
 * credential document. Anything else 404s, which is what a real IMDS does.
 */
function createFakeImds(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'PUT' && req.url === '/latest/api/token') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('fake-imds-token');
      return;
    }
    if (req.url === '/latest/meta-data/iam/security-credentials/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(INSTANCE_ROLE);
      return;
    }
    if (req.url === `/latest/meta-data/iam/security-credentials/${INSTANCE_ROLE}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          Code: 'Success',
          Type: 'AWS-HMAC',
          AccessKeyId: INSTANCE_ROLE_ACCESS_KEY_ID,
          SecretAccessKey: 'instance-role-secret',
          Token: 'instance-role-session-token',
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

describe('createCloudWatchClient — pinned credential provider', () => {
  let imds: http.Server;
  let imdsEndpoint: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    imds = createFakeImds();
    await new Promise<void>((resolve) => imds.listen(0, '127.0.0.1', resolve));
    imdsEndpoint = `http://127.0.0.1:${(imds.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => imds.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    capturedConfigs.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_REGION',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = imdsEndpoint;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves the instance-role identity even when AWS_ACCESS_KEY_ID is set', async () => {
    process.env.AWS_ACCESS_KEY_ID = IMPOSTOR_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = 'impostor-secret';

    createCloudWatchClient();

    const { credentials } = capturedConfigs[0];
    // Unpinned code passes no `credentials` at all and this line is the
    // first thing to blow up — which is the point of asserting it.
    expect(typeof credentials).toBe('function');

    const resolved = await credentials();
    expect(resolved.accessKeyId).toBe(INSTANCE_ROLE_ACCESS_KEY_ID);
    expect(resolved.accessKeyId).not.toBe(IMPOSTOR_ACCESS_KEY_ID);
    expect(resolved.sessionToken).toBe('instance-role-session-token');
  });

  it('resolves the same instance-role identity when no AWS_* credentials are set', async () => {
    createCloudWatchClient();

    const resolved = await capturedConfigs[0].credentials();
    expect(resolved.accessKeyId).toBe(INSTANCE_ROLE_ACCESS_KEY_ID);
  });

  it('still honours AWS_REGION, which carries no identity', () => {
    process.env.AWS_REGION = 'us-west-2';
    createCloudWatchClient();
    expect(capturedConfigs[0].region).toBe('us-west-2');

    capturedConfigs.length = 0;
    delete process.env.AWS_REGION;
    createCloudWatchClient();
    expect(capturedConfigs[0].region).toBe('us-east-1');
  });

  it('pins the client the buffered emitter builds, not just direct callers', async () => {
    process.env.AWS_ACCESS_KEY_ID = IMPOSTOR_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = 'impostor-secret';

    const emitter = createBufferedMetricEmitter({ namespace: 'WXYC/Test' });
    emitter.record({ metricName: 'Widgets' });
    await emitter.flush();

    expect(capturedConfigs).toHaveLength(1);
    const resolved = await capturedConfigs[0].credentials();
    expect(resolved.accessKeyId).toBe(INSTANCE_ROLE_ACCESS_KEY_ID);
  });
});

/**
 * The pin above is only worth as much as its coverage. A second
 * `new CloudWatchClient({ region })` anywhere in the tree is a second identity
 * decision, and the one that went dark in BS#2518 was exactly such a copy —
 * so the count of construction sites is the invariant, pinned here the way the
 * barrel's no-AWS-re-export rule is pinned in `metrics.test.ts`. Adding a
 * CloudWatch publisher means calling `createCloudWatchClient()`, not
 * amending this list.
 */
describe('CloudWatch client construction sites', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const sourceRoots = ['apps', 'jobs', 'shared', 'scripts'];

  function walk(dir: string, out: string[]): string[] {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('constructs a CloudWatchClient in exactly one file', () => {
    const files: string[] = [];
    for (const root of sourceRoots) {
      const dir = path.join(repoRoot, root);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (fs.existsSync(dir)) walk(dir, files);
    }

    const constructors = files.filter((file) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      /new\s+CloudWatchClient\s*\(/.test(fs.readFileSync(file, 'utf-8'))
    );

    expect(constructors.map((f) => path.relative(repoRoot, f))).toEqual(['shared/observability/src/metrics.ts']);
  });
});
