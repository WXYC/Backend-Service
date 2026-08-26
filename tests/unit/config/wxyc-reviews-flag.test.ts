/**
 * Unit tests for the WXYC_REVIEWS_ENABLED flag (consented DJ album reviews,
 * ADR 0011). The load-bearing property is strict `=== 'true'` gating: an
 * accidental `WXYC_REVIEWS_ENABLED=1` must NOT add a query to the hot
 * album-metadata serve path, and — more sharply than for critic reviews —
 * must not begin publishing reviewer-authored bodies on a typo. Mirrors
 * `critic-reviews-flag.test.ts`.
 */
import { getConfig, loadConfig, resetConfig } from '../../../apps/backend/config/wxycReviews';

describe('wxycReviews flag config', () => {
  const original = process.env.WXYC_REVIEWS_ENABLED;

  beforeEach(() => {
    delete process.env.WXYC_REVIEWS_ENABLED;
    resetConfig();
  });

  afterAll(() => {
    if (original === undefined) delete process.env.WXYC_REVIEWS_ENABLED;
    else process.env.WXYC_REVIEWS_ENABLED = original;
    resetConfig();
  });

  it('defaults to disabled when the env var is unset', () => {
    expect(loadConfig().enabled).toBe(false);
  });

  it('enables only on the exact string "true"', () => {
    process.env.WXYC_REVIEWS_ENABLED = 'true';
    expect(loadConfig().enabled).toBe(true);
  });

  it.each(['1', 'TRUE', 'yes', 'on', ''])('does not enable on non-canonical value %p', (value) => {
    process.env.WXYC_REVIEWS_ENABLED = value;
    expect(loadConfig().enabled).toBe(false);
  });

  it('caches the singleton until resetConfig() is called', () => {
    process.env.WXYC_REVIEWS_ENABLED = 'true';
    expect(getConfig().enabled).toBe(true);
    // Mutating the env without resetting must not change the cached value.
    delete process.env.WXYC_REVIEWS_ENABLED;
    expect(getConfig().enabled).toBe(true);
    resetConfig();
    expect(getConfig().enabled).toBe(false);
  });
});
