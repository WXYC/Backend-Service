/**
 * library-etl refuses to run unless explicitly opted in (WXYC/Backend-Service#2581).
 *
 * Same contract as the flowsheet and rotation siblings, different hazard. The
 * refusal message has to name the library-specific reverts — the catalog columns
 * and the crossreference's `artist_genre_code` — because an operator who has
 * internalized the flowsheet job's mirror back-stamp story would otherwise
 * conclude the run only touches rows tubafrenzy still owns.
 */

import {
  BACKWARDS_WRITE_ENV,
  isBackwardsWriteAllowed,
  backwardsWriteRefusalMessage,
} from '../../../../jobs/library-etl/backwards-write-guard';

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
  const message = backwardsWriteRefusalMessage('library-etl');

  it.each([
    ['the job it refused', 'library-etl'],
    ['the override variable', BACKWARDS_WRITE_ENV],
    ['the reverted catalog columns', 'code_number'],
    ['the reverted crossreference call number', 'artist_genre_code'],
    ['the frozen source date', '2026-09-16'],
    ['the watermark full-resync hazard', 'cronjob_runs'],
  ])('names %s', (_label, needle) => {
    expect(message).toContain(needle);
  });

  it('describes the library revert rather than the flowsheet back-stamp story', () => {
    expect(message).not.toContain('legacy_show_id');
  });
});
