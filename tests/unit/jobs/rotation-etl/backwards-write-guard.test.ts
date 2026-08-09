/**
 * The retained rotation-etl refuses to run unless explicitly opted in.
 *
 * Same contract as the flowsheet sibling, different hazard. There is no
 * rotation mirror, so this job cannot reach a pure dj-site row — what it
 * reaches is every row that ever came from tubafrenzy, whose Backend-side
 * edits it reverts. The refusal message has to say so, because an operator who
 * has internalized the flowsheet job's "the mirror back-stamps the key" story
 * would otherwise conclude that a rotation row with a NULL `legacy_rotation_id`
 * makes the run safe.
 */

import {
  BACKWARDS_WRITE_ENV,
  isBackwardsWriteAllowed,
  backwardsWriteRefusalMessage,
} from '../../../../jobs/rotation-etl/backwards-write-guard';

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
  const message = backwardsWriteRefusalMessage('rotation-etl');

  it('names the job it refused', () => {
    expect(message).toContain('rotation-etl');
  });

  it('names the override variable so the operator can find it', () => {
    expect(message).toContain(BACKWARDS_WRITE_ENV);
  });

  it('points at the scheduled repair job, which is the usual actual intent', () => {
    expect(message).toContain('@wxyc/legacy-linkage-resolve');
  });

  it('describes the revert hazard rather than the flowsheet back-stamp story', () => {
    expect(message).toContain('rotation_bin');
    expect(message).toContain('discogs_release_id_source');
    expect(message).not.toContain('legacy_show_id');
  });

  it('warns about the frozen watermark, which only bites the first run after the gap', () => {
    expect(message).toContain('watermark');
  });
});
