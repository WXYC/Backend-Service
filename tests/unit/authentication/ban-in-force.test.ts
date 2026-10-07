import { describe, it, expect } from '@jest/globals';

import { isBanInForce } from '../../../shared/authentication/src/ban-in-force';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const past = new Date(NOW - 60_000);
const future = new Date(NOW + 60_000);

describe('isBanInForce', () => {
  it.each([
    ['not banned', { banned: false, banExpires: null }, false],
    ['banned, no expiry', { banned: true, banExpires: null }, true],
    ['banned, expiring in the future', { banned: true, banExpires: future }, true],
    ['banned, already expired', { banned: true, banExpires: past }, false],
    ['banned, expiring exactly now', { banned: true, banExpires: new Date(NOW) }, false],
    ['banned, expiry not a valid date (fails closed)', { banned: true, banExpires: new Date('infinity') }, true],
    ['banned is null', { banned: null, banExpires: null }, false],
    ['banned is null with a future expiry', { banned: null, banExpires: future }, false],
  ])('%s', (_label, account, expected) => {
    expect(isBanInForce(account, NOW)).toBe(expected);
  });

  it('defaults now to the current time', () => {
    expect(isBanInForce({ banned: true, banExpires: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isBanInForce({ banned: true, banExpires: new Date(Date.now() - 60_000) })).toBe(false);
  });
});
