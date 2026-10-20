import * as Sentry from '@sentry/node';
import { createJobLogger, errorMessageWithCause, resolveTracesSampleRate } from '@wxyc/observability/job-logger';
import { getErrorReporter } from '@wxyc/observability';

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
        'withHeartbeat',
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

  it('passes a job-supplied tracesSampler to Sentry.init, and none when the job supplies none', () => {
    createJobLogger({ jobName: 'demo-job' }).initLogger({ repo: 'r', tool: 't' });
    expect(sentry.init.mock.calls[0][0]).not.toHaveProperty('tracesSampler');

    const tracesSampler = jest.fn().mockReturnValue(0.25);
    createJobLogger({ jobName: 'demo-job', tracesSampler }).initLogger({ repo: 'r', tool: 't' });
    expect(sentry.init).toHaveBeenLastCalledWith(expect.objectContaining({ tracesSampler, tracesSampleRate: 1 }));
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

  describe('captureCounter', () => {
    let consoleLog: jest.SpyInstance;
    beforeEach(() => {
      consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => consoleLog.mockRestore());

    it('writes exactly one line with the metric, value, call-site fields and the run fields', () => {
      const { initLogger, captureCounter } = createJobLogger({ jobName: 'demo-job' });
      initLogger({ repo: 'r', tool: 't', runId: 'run-1' });
      captureCounter('c', 2, { k: 'v' });
      expect(consoleLog).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleLog.mock.calls[0][0])).toEqual({
        metric: 'c',
        value: 2,
        k: 'v',
        repo: 'r',
        tool: 't',
        run_id: 'run-1',
      });
    });

    it('does not let call-site fields override the run fields', () => {
      const { initLogger, captureCounter } = createJobLogger({ jobName: 'demo-job' });
      initLogger({ repo: 'r', tool: 't', runId: 'run-1' });
      captureCounter('c', 1, { repo: 'x', tool: 'y', run_id: 'z' });
      expect(JSON.parse(consoleLog.mock.calls[0][0])).toMatchObject({ repo: 'r', tool: 't', run_id: 'run-1' });
    });

    it('emits without run fields, and does not throw, before initLogger', () => {
      const { captureCounter } = createJobLogger({ jobName: 'demo-job' });
      expect(() => captureCounter('c', 1, { k: 'v' })).not.toThrow();
      expect(JSON.parse(consoleLog.mock.calls[0][0])).toEqual({ metric: 'c', value: 1, k: 'v' });
    });

    it('never throws', () => {
      consoleLog.mockImplementation(() => {
        throw new Error('x');
      });
      const { captureCounter } = createJobLogger({ jobName: 'demo-job' });
      expect(() => captureCounter('c', 1)).not.toThrow();
    });
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

  it('initLogger registers the logger reporter as the process-wide reporter', () => {
    const { reporter, initLogger } = createJobLogger({ jobName: 'demo-job' });
    initLogger({ repo: 'r', tool: 't' });
    expect(getErrorReporter()).toBe(reporter);
  });

  it('a capture through getErrorReporter after initLogger reaches the logger reporter', () => {
    const { reporter, initLogger } = createJobLogger({ jobName: 'demo-job' });
    const capture = jest.spyOn(reporter, 'captureMessage');
    initLogger({ repo: 'r', tool: 't' });
    getErrorReporter().captureMessage('shared-lib warning', { level: 'warning' });
    expect(capture).toHaveBeenCalledWith('shared-lib warning', { level: 'warning' });
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

describe('errorMessageWithCause', () => {
  it.each([
    ['an Error with no cause', new Error('boom'), 'boom'],
    ['an Error cause', new Error('outer', { cause: new Error('inner') }), 'outer [cause: inner]'],
    ['a string cause', new Error('outer', { cause: 'inner text' }), 'outer [cause: inner text]'],
    ['a cause equal to the message', new Error('same', { cause: new Error('same') }), 'same'],
    ['an empty string cause', new Error('outer', { cause: '' }), 'outer'],
    ['an object cause', new Error('outer', { cause: { code: 42 } }), 'outer'],
    ['a non-Error string', 'just a string', 'just a string'],
    ['a non-Error object', { code: 42 }, '[object Object]'],
  ])('%s', (_label, input, expected) => {
    expect(errorMessageWithCause(input)).toBe(expected);
  });
});
