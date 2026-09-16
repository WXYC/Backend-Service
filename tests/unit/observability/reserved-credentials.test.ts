/**
 * Unit tests for the reserved-AWS-credential-name detector (BS#2532).
 *
 * The detector this file covers used to live in the three SES senders, where
 * it could not fire in the process it protects: `apps/backend` holds two of
 * the repo's three `CloudWatchClient` constructions and sends no email at all,
 * so the container whose metrics the shadowing actually kills never ran the
 * check. It now lives in `@wxyc/observability` and is called from each app's
 * Sentry preload (`instrument.ts`, `node --import`), which is the only place
 * that runs in every container regardless of what the container goes on to do.
 *
 * Imported through the package BARREL on purpose: the barrel is what the
 * preloads load, so a detector exported only from a subpath would not be
 * reachable from the call site that matters. The barrel-safety assertions at
 * the bottom pin the other half of that — the detector must never drag an AWS
 * SDK into a preload that every process pays for.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Every name the AWS SDK's default credential chain consults ahead of the EC2
 * instance role, and the same four `.github/workflows/set-ec2-env-var.yml`
 * refuses to write to the host.
 */
const RESERVED_NAMES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'] as const;

const loadDetector = async () => {
  jest.resetModules();
  const mod = await import('@wxyc/observability');
  return mod.warnIfReservedAwsCredentialsPresent;
};

describe('warnIfReservedAwsCredentialsPresent (BS#2532)', () => {
  const saved = new Map<string, string | undefined>();
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    for (const name of RESERVED_NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    saved.set('AWS_REGION', process.env.AWS_REGION);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  // Restored in afterEach rather than in-body: jest does not reset process.env
  // between test FILES in a worker, so a reserved name leaking out of here
  // would arm the detector (and, worse, the AWS SDK's credential chain) for
  // every later file that shares this worker.
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    saved.clear();
    warn.mockRestore();
  });

  it.each(RESERVED_NAMES)('warns when the reserved %s is set', async (name) => {
    process.env[name] = 'set-by-an-operator';
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(name);
  });

  it('names the shadowing hazard, the SES_* spelling, and the incident', async () => {
    // The message is the entire deliverable — an operator reading it at boot
    // has to learn what breaks (the instance role is shadowed), where the SES
    // credential actually belongs, and where to read the history. A warning
    // that only says "this is set" restates what they can already see.
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();

    const message = warn.mock.calls[0][0] as string;
    expect(message).toMatch(/shadows the EC2 instance role/);
    expect(message).toMatch(/SES_ACCESS_KEY_ID/);
    expect(message).toMatch(/SES_SECRET_ACCESS_KEY/);
    expect(message).toMatch(/BS#2518/);
  });

  it('stays silent when no reserved name is set', async () => {
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not flag AWS_REGION, which carries no identity', async () => {
    // AWS_REGION is the one AWS_* name production is SUPPOSED to set: it
    // selects an endpoint, not a principal, so it sits nowhere in the
    // credential chain. Flagging it would teach operators to ignore the
    // warning, which is the only failure mode a detector really has.
    process.env.AWS_REGION = 'us-east-1';
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();

    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an empty value as unset', async () => {
    // `set-ec2-env-var.yml` refuses to write an empty value, but a hand-edited
    // `~/.env` can leave `AWS_PROFILE=` behind. An empty string contributes
    // nothing to the credential chain, so warning on it would be noise that
    // no action clears.
    process.env.AWS_ACCESS_KEY_ID = '';
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns at most once across repeated calls', async () => {
    // Moved here from `tests/unit/services/email.test.ts` with the detector it
    // covers (BS#2532); the credential-RESOLUTION cases stayed behind.
    //
    // The bootstrap call site makes the guard moot on its own, but the guard is
    // what makes the function safe to call from anywhere — and the previous
    // call site proves that matters: `getSesClient` memoizes only on success,
    // so an unconfigured-SES process re-entered `resolveSesCredentials` on
    // every single send. Without the guard that is one log line per email
    // attempt, and a flooded log is read about as carefully as a silent one.
    // BS#2518 ran dark for 105 days on unobservability; the fix must not trade
    // it for unreadability.
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();
    warnIfReservedAwsCredentialsPresent();
    warnIfReservedAwsCredentialsPresent();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports every reserved name present, not just the first', async () => {
    // A half-fixed host is the likely second state: an operator who unsets
    // AWS_ACCESS_KEY_ID and leaves AWS_PROFILE behind has not cleared the
    // shadowing. With a once-per-process guard, the first warning is the only
    // one they get, so it has to carry the whole list.
    process.env.AWS_ACCESS_KEY_ID = 'aws-key';
    process.env.AWS_PROFILE = 'wxyc-api';
    const warnIfReservedAwsCredentialsPresent = await loadDetector();

    warnIfReservedAwsCredentialsPresent();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/AWS_ACCESS_KEY_ID/);
    expect(warn.mock.calls[0][0]).toMatch(/AWS_PROFILE/);
  });
});

/**
 * Companion to the `@wxyc/observability barrel` block in `metrics.test.ts`,
 * which pins that the barrel itself pulls in no AWS SDK. This detector is the
 * barrel's second re-export, and a bare `process.env` read is what keeps it
 * legitimately barrel-safe — an implementation that reached for
 * `@aws-sdk/credential-providers` to "check the resolved identity properly"
 * would satisfy every behavioural test above while loading an AWS SDK into
 * every container at preload, which is precisely the cost the barrel rule
 * exists to avoid.
 */
describe('reserved-credentials source', () => {
  const sourcePath = path.resolve(__dirname, '../../../shared/observability/src/reserved-credentials.ts');

  it('imports no AWS SDK', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).not.toMatch(/@aws-sdk/);
  });

  /**
   * The stronger form, and the one that actually holds the line. Matching on
   * `@aws-sdk` only catches a DIRECT import: a re-export of this package's own
   * `./metrics.js` pulls `@aws-sdk/client-cloudwatch` into the preload barrel
   * of all three containers while containing no `@aws-sdk` string of its own,
   * so the assertion above passes and the cost ships anyway. Asserting the
   * documented invariant instead — this module imports NOTHING — closes the
   * transitive hole without having to enumerate what must not be reached.
   */
  it('imports nothing at all', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s[^;]*\sfrom\s/m);
  });
});

/**
 * BS#2532's whole premise is that the detector existed but was not invoked
 * where it mattered, so the function being correct is only half of it — the
 * other half is that each preload still calls it. Nothing else in the suite
 * pins that: delete the call from `apps/backend/instrument.ts` and typecheck,
 * lint and every other test stay green while the container that publishes
 * `WXYC/BackendService` silently loses the only detection of the condition
 * that ran dark for 105 days.
 *
 * Source-text assertions rather than an import, because these files are
 * `node --import` preloads whose module scope calls `Sentry.init()` and
 * `config()` — importing one into a test would execute both.
 *
 * Mirrors the `instrument.ts wiring` block in
 * `tests/unit/config/sentry-transaction-filter.test.ts`, which pins the other
 * thing the preloads are load-bearing for.
 */
describe('instrument.ts wiring (BS#2532)', () => {
  it.each([
    ['backend', '../../../apps/backend/instrument.ts'],
    ['auth', '../../../apps/auth/instrument.ts'],
    ['enrichment-worker', '../../../apps/enrichment-worker/instrument.ts'],
  ])('%s preload calls the detector after config()', (_app, relPath) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');

    expect(source).toMatch(/from ['"]@wxyc\/observability['"]/);
    expect(source).toMatch(/warnIfReservedAwsCredentialsPresent\(\)/);

    // Ordering matters: `config()` is what loads `.env` into `process.env`, so
    // a detector called before it reads an environment the deploy has not
    // finished populating and reports a clean host that is not clean.
    const configAt = source.indexOf('config()');
    const detectorAt = source.indexOf('warnIfReservedAwsCredentialsPresent()');
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(detectorAt).toBeGreaterThan(configAt);
  });
});
