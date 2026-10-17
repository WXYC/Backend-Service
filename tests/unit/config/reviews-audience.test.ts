/**
 * Unit tests for REVIEWS_AUDIENCE (who can see the review screens). It takes the DJ site's
 * `NEXT_PUBLIC_REVIEWS_ENABLED` spellings: `staff`, and `true` or `1` for everyone; anything else, including
 * `TRUE` and `yes`, is off. It ships off.
 */
import { getConfig, loadConfig, resetConfig } from '../../../apps/backend/config/reviewsAudience';

describe('reviewsAudience config', () => {
  const original = process.env.REVIEWS_AUDIENCE;

  beforeEach(() => {
    delete process.env.REVIEWS_AUDIENCE;
    resetConfig();
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env.REVIEWS_AUDIENCE;
    } else {
      process.env.REVIEWS_AUDIENCE = original;
    }
    resetConfig();
  });

  it.each([
    [undefined, 'off'],
    ['', 'off'],
    ['staff', 'staff'],
    ['true', 'everyone'],
    ['1', 'everyone'],
    ['TRUE', 'off'],
    ['yes', 'off'],
    ['false', 'off'],
    ['on', 'off'],
    ['Staff', 'off'],
  ])('reads %p as %s', (value, audience) => {
    if (value !== undefined) {
      process.env.REVIEWS_AUDIENCE = value;
    }
    expect(loadConfig().audience).toBe(audience);
  });

  it('caches the singleton until resetConfig() is called', () => {
    process.env.REVIEWS_AUDIENCE = 'true';
    expect(getConfig().audience).toBe('everyone');
    delete process.env.REVIEWS_AUDIENCE;
    expect(getConfig().audience).toBe('everyone');
    resetConfig();
    expect(getConfig().audience).toBe('off');
  });
});
