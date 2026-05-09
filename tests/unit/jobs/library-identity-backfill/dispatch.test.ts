/**
 * Unit tests for the job entrypoint's leg dispatcher.
 *
 * `resolveBackfillLeg` parses the `BACKFILL_LEG` env var into a typed
 * value. The default-to-`S1` case preserves sub-PR 2.0 behavior; `S2`
 * selects the new leg added in sub-PR 2.1; anything else throws so a
 * typo can't silently fall back to S1 and skip the operator's intent.
 */
import { resolveBackfillLeg } from '../../../../jobs/library-identity-backfill/dispatch';

describe('resolveBackfillLeg', () => {
  it('defaults to S1 when the env var is undefined', () => {
    expect(resolveBackfillLeg(undefined)).toBe('S1');
  });

  it('defaults to S1 when the env var is empty string', () => {
    expect(resolveBackfillLeg('')).toBe('S1');
  });

  it('accepts S1 explicitly', () => {
    expect(resolveBackfillLeg('S1')).toBe('S1');
  });

  it('accepts S2', () => {
    expect(resolveBackfillLeg('S2')).toBe('S2');
  });

  it('throws on a malformed value rather than silently falling back', () => {
    // A typo like 'S3' (future-leg) or 'S1 ' (trailing whitespace) should
    // surface as an error at job start, not silently default to S1 and run
    // the wrong backfill against prod.
    expect(() => resolveBackfillLeg('s2')).toThrow();
    expect(() => resolveBackfillLeg('S3')).toThrow();
    expect(() => resolveBackfillLeg('S1 ')).toThrow();
    expect(() => resolveBackfillLeg('1')).toThrow();
  });

  it('error message names the offending value so operators can debug', () => {
    expect(() => resolveBackfillLeg('S99')).toThrow(/S99/);
  });
});
