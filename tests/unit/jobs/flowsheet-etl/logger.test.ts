/**
 * Smoke tests for the flowsheet-etl observability logger.
 *
 * Phase A foundation contract: every log line carries the four tags
 * `repo`, `tool`, `step`, `run_id`. Sentry stays inactive when SENTRY_DSN
 * is unset (no panic, no network calls).
 */

import { resolveTracesSampleRate } from '../../../../jobs/flowsheet-etl/logger';

describe('resolveTracesSampleRate', () => {
  it('defaults to 0 when env var is unset', () => {
    expect(resolveTracesSampleRate(undefined)).toBe(0);
  });

  it('parses valid values in [0, 1]', () => {
    expect(resolveTracesSampleRate('0')).toBe(0);
    expect(resolveTracesSampleRate('0.5')).toBe(0.5);
    expect(resolveTracesSampleRate('1')).toBe(1);
    expect(resolveTracesSampleRate('1.0')).toBe(1);
  });

  it('falls back to 0 on malformed or out-of-range values', () => {
    expect(resolveTracesSampleRate('abc')).toBe(0);
    expect(resolveTracesSampleRate('-0.5')).toBe(0);
    expect(resolveTracesSampleRate('1.5')).toBe(0);
    expect(resolveTracesSampleRate('NaN')).toBe(0);
    expect(resolveTracesSampleRate('Infinity')).toBe(0);
  });
});

describe('flowsheet-etl logger', () => {
  const originalDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
    jest.resetModules();
  });

  it('initializes without panic when SENTRY_DSN is unset', async () => {
    delete process.env.SENTRY_DSN;
    const { initLogger, closeLogger } = await import('../../../../jobs/flowsheet-etl/logger');

    expect(() => initLogger({ repo: 'Backend-Service', tool: 'flowsheet-etl test' })).not.toThrow();
    await closeLogger();
  });

  it('emits a JSON line carrying repo/tool/step/run_id tags', async () => {
    delete process.env.SENTRY_DSN;
    const { initLogger, log, closeLogger } = await import('../../../../jobs/flowsheet-etl/logger');

    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString());
      return true;
    });

    const runId = initLogger({ repo: 'Backend-Service', tool: 'flowsheet-etl incremental' });
    log('info', 'started', 'incremental sync starting', { extra: 1 });
    spy.mockRestore();
    await closeLogger();

    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0].trim());
    expect(parsed.repo).toBe('Backend-Service');
    expect(parsed.tool).toBe('flowsheet-etl incremental');
    expect(parsed.step).toBe('started');
    expect(parsed.run_id).toBe(runId);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('incremental sync starting');
    expect(parsed.extra).toBe(1);
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('uses an explicit run_id when provided', async () => {
    delete process.env.SENTRY_DSN;
    const { initLogger, closeLogger } = await import('../../../../jobs/flowsheet-etl/logger');

    const runId = initLogger({
      repo: 'Backend-Service',
      tool: 'flowsheet-etl test',
      runId: 'fixed-run-id',
    });
    expect(runId).toBe('fixed-run-id');
    await closeLogger();
  });

  it('writes errors to stderr', async () => {
    delete process.env.SENTRY_DSN;
    const { initLogger, log, closeLogger } = await import('../../../../jobs/flowsheet-etl/logger');

    const errWrites: string[] = [];
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errWrites.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString());
      return true;
    });

    initLogger({ repo: 'Backend-Service', tool: 'flowsheet-etl test' });
    log('error', 'crash', 'boom');
    errSpy.mockRestore();
    await closeLogger();

    expect(errWrites.length).toBe(1);
    const parsed = JSON.parse(errWrites[0].trim());
    expect(parsed.level).toBe('error');
    expect(parsed.step).toBe('crash');
  });
});
