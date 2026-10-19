import * as Sentry from '@sentry/node';
import { createJobLogger, resolveTracesSampleRate } from '@wxyc/observability/job-logger';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  getCurrentScope: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
  close: jest.fn().mockResolvedValue(true),
}));

const sentry = jest.mocked(Sentry);

describe('createJobLogger', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('exposes the exports jobs use today plus the reporter', () => {
    const logger = createJobLogger({ jobName: 'demo-job' });
    expect(Object.keys(logger).sort()).toEqual(
      [
        'captureCounter',
        'captureError',
        'captureMessage',
        'captureWarning',
        'closeLogger',
        'errorMessage',
        'initLogger',
        'log',
        'reporter',
        'resolveTracesSampleRate',
      ].sort()
    );
  });

  it('initLogger initializes Sentry, sets the run-wide tags and returns the run id', () => {
    const { initLogger } = createJobLogger({ jobName: 'demo-job' });
    const runId = initLogger({ repo: 'r', tool: 't', runId: 'run-1' });
    expect(runId).toBe('run-1');
    expect(sentry.init).toHaveBeenCalledWith(expect.objectContaining({ attachStacktrace: false }));
    expect(sentry.setTag).toHaveBeenCalledWith('repo', 'r');
    expect(sentry.setTag).toHaveBeenCalledWith('tool', 't');
    expect(sentry.setTag).toHaveBeenCalledWith('run_id', 'run-1');
  });

  it('generates a run id when none is given', () => {
    const { initLogger } = createJobLogger({ jobName: 'demo-job' });
    expect(initLogger({ repo: 'r', tool: 't' })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('log is silent before initLogger and writes tagged JSON lines after', () => {
    const { initLogger, log } = createJobLogger({ jobName: 'demo-job' });
    log('info', 's', 'early');
    expect(stdout).not.toHaveBeenCalled();
    initLogger({ repo: 'r', tool: 't', runId: 'run-1' });
    log('info', 'step-a', 'hello', { n: 1 });
    log('error', 'step-b', 'bad');
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      level: 'info',
      step: 'step-a',
      message: 'hello',
      repo: 'r',
      tool: 't',
      run_id: 'run-1',
      n: 1,
    });
    expect(JSON.parse(stderr.mock.calls[0][0])).toMatchObject({ level: 'error', step: 'step-b' });
  });

  it('captureError goes through the reporter with the step tag and extra', () => {
    const { reporter, captureError } = createJobLogger({ jobName: 'demo-job' });
    const spy = jest.spyOn(reporter, 'captureException');
    const err = new Error('boom');
    captureError(err, 'step-a', { id: 3 });
    expect(spy).toHaveBeenCalledWith(err, { tags: { step: 'step-a' }, extra: { id: 3 } });
    expect(sentry.captureException).toHaveBeenCalledWith(err, { tags: { step: 'step-a' }, extra: { id: 3 } });
  });

  it('captureWarning fingerprints by jobName and step', () => {
    const { captureWarning } = createJobLogger({ jobName: 'demo-job' });
    captureWarning('gap', 'step-a', { n: 2 });
    expect(sentry.captureMessage).toHaveBeenCalledWith('gap', {
      level: 'warning',
      fingerprint: ['demo-job', 'step-a'],
      tags: { step: 'step-a' },
      extra: { n: 2 },
    });
  });

  it('captureMessage reports a warning without a fingerprint', () => {
    const { captureMessage } = createJobLogger({ jobName: 'demo-job' });
    captureMessage('note', 'step-a', { n: 2 });
    expect(sentry.captureMessage).toHaveBeenCalledWith('note', {
      level: 'warning',
      tags: { step: 'step-a' },
      extra: { n: 2 },
    });
  });

  it('captureCounter maps to the reporter recordCounter', () => {
    const { reporter, captureCounter } = createJobLogger({ jobName: 'demo-job' });
    const spy = jest.spyOn(reporter, 'recordCounter').mockImplementation(() => undefined);
    captureCounter('c', 2, { k: 'v' });
    expect(spy).toHaveBeenCalledWith('c', 2, { k: 'v' });
  });

  it('captureCounter never throws', () => {
    const { reporter, captureCounter } = createJobLogger({ jobName: 'demo-job' });
    jest.spyOn(reporter, 'recordCounter').mockImplementation(() => {
      throw new Error('x');
    });
    expect(() => captureCounter('c', 1)).not.toThrow();
  });

  it('closeLogger flushes the reporter, closes Sentry and silences log', async () => {
    const { reporter, initLogger, log, closeLogger } = createJobLogger({ jobName: 'demo-job' });
    const flush = jest.spyOn(reporter, 'flush');
    initLogger({ repo: 'r', tool: 't' });
    await closeLogger();
    expect(flush).toHaveBeenCalledWith(2000);
    expect(sentry.close).toHaveBeenCalledWith(2000);
    log('info', 's', 'late');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('closeLogger awaits reporter.flush(2000) before calling Sentry.close(2000)', async () => {
    const { reporter, initLogger, closeLogger } = createJobLogger({ jobName: 'demo-job' });
    const order: string[] = [];
    jest.spyOn(reporter, 'flush').mockImplementation(async (timeout) => {
      order.push(`flush-start:${timeout}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push('flush-done');
      return true;
    });
    sentry.close.mockImplementationOnce((timeout) => {
      order.push(`close:${timeout}`);
      return Promise.resolve(true);
    });
    initLogger({ repo: 'r', tool: 't' });
    await closeLogger();
    expect(order).toEqual(['flush-start:2000', 'flush-done', 'close:2000']);
  });

  it('errorMessage handles non-Error throws', () => {
    const { errorMessage } = createJobLogger({ jobName: 'demo-job' });
    expect(errorMessage(new Error('m'))).toBe('m');
    expect(errorMessage('str')).toBe('str');
  });
});

describe('resolveTracesSampleRate', () => {
  it.each([
    [undefined, 1],
    ['0.25', 0.25],
    ['0', 0],
    ['2', 1],
    ['-1', 1],
    ['abc', 1],
  ])('%s -> %s', (raw, expected) => {
    expect(resolveTracesSampleRate(raw)).toBe(expected);
  });
});
