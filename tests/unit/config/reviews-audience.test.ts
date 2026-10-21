/**
 * Unit tests for REVIEWS_AUDIENCE's spellings (who can see the review screens). It takes the DJ site's
 * `NEXT_PUBLIC_REVIEWS_ENABLED` spellings: `staff`, and `true` or `1` for everyone; anything else, including
 * `TRUE` and `yes`, is off. It ships off.
 */
import { parseAudience } from '../../../apps/backend/config/reviewsAudience';

describe('parseAudience', () => {
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
    expect(parseAudience(value)).toBe(audience);
  });
});
