/**
 * The retained flowsheet-etl refuses to run unless explicitly opted in.
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) unscheduled this job
 * but deliberately kept the code invocable. After the SOURCE flip every mode it
 * offers imports FROM tubafrenzy onto tables Backend now owns, so the default
 * has to be "refuse" — an operator reaching for a one-shot in a maintenance
 * window should not be able to clobber Backend-canonical rows by accident.
 *
 * The opt-in is deliberately the exact string '1'. Anything looser ('true',
 * 'yes', any non-empty value) risks a stray or inherited env var arming a
 * backwards write silently.
 */

import {
  BACKWARDS_WRITE_ENV,
  isBackwardsWriteAllowed,
  backwardsWriteRefusalMessage,
} from '../../../../jobs/flowsheet-etl/backwards-write-guard';

describe('isBackwardsWriteAllowed', () => {
  it('allows the write only on the exact string "1"', () => {
    expect(isBackwardsWriteAllowed('1')).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['true', 'true'],
    ['TRUE', 'TRUE'],
    ['yes', 'yes'],
    ['padded 1', ' 1 '],
    ['1 with trailing text', '1x'],
  ])('refuses when the env var is %s', (_label, value) => {
    expect(isBackwardsWriteAllowed(value)).toBe(false);
  });

  it('reads process.env by default', () => {
    const original = process.env[BACKWARDS_WRITE_ENV];
    try {
      delete process.env[BACKWARDS_WRITE_ENV];
      expect(isBackwardsWriteAllowed()).toBe(false);

      process.env[BACKWARDS_WRITE_ENV] = '1';
      expect(isBackwardsWriteAllowed()).toBe(true);
    } finally {
      if (original === undefined) delete process.env[BACKWARDS_WRITE_ENV];
      else process.env[BACKWARDS_WRITE_ENV] = original;
    }
  });
});

describe('backwardsWriteRefusalMessage', () => {
  const message = backwardsWriteRefusalMessage('flowsheet-etl');

  it('names the job it refused', () => {
    expect(message).toContain('flowsheet-etl');
  });

  it('names the override variable so the operator can find it', () => {
    expect(message).toContain(BACKWARDS_WRITE_ENV);
  });

  it('points at the scheduled repair job, which is the usual actual intent', () => {
    expect(message).toContain('@wxyc/legacy-linkage-resolve');
  });

  it('names the keys whose back-stamping makes this a backwards write', () => {
    expect(message).toContain('legacy_show_id');
    expect(message).toContain('legacy_entry_id');
  });
});
