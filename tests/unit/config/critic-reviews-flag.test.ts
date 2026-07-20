/**
 * Unit tests for the CRITIC_REVIEWS_ENABLED flag (album-critic-reviews slice,
 * ADR 0012). The load-bearing property is strict `=== 'true'` gating: an
 * accidental `CRITIC_REVIEWS_ENABLED=1` must NOT add a query to the hot
 * album-metadata serve path. Mirrors the catalogSearchAlias config contract.
 */
import { getConfig, loadConfig, resetConfig } from '../../../apps/backend/config/criticReviews';

describe('criticReviews flag config', () => {
  const original = process.env.CRITIC_REVIEWS_ENABLED;

  beforeEach(() => {
    delete process.env.CRITIC_REVIEWS_ENABLED;
    resetConfig();
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CRITIC_REVIEWS_ENABLED;
    else process.env.CRITIC_REVIEWS_ENABLED = original;
    resetConfig();
  });

  it('defaults to disabled when the env var is unset', () => {
    expect(loadConfig().enabled).toBe(false);
  });

  it('enables only on the exact string "true"', () => {
    process.env.CRITIC_REVIEWS_ENABLED = 'true';
    expect(loadConfig().enabled).toBe(true);
  });

  it.each(['1', 'TRUE', 'yes', 'on', ''])('does not enable on non-canonical value %p', (value) => {
    process.env.CRITIC_REVIEWS_ENABLED = value;
    expect(loadConfig().enabled).toBe(false);
  });

  it('caches the singleton until resetConfig() is called', () => {
    process.env.CRITIC_REVIEWS_ENABLED = 'true';
    expect(getConfig().enabled).toBe(true);
    // Mutating the env without resetting must not change the cached value.
    delete process.env.CRITIC_REVIEWS_ENABLED;
    expect(getConfig().enabled).toBe(true);
    resetConfig();
    expect(getConfig().enabled).toBe(false);
  });
});
