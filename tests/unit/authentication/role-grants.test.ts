import { roleGrants } from '../../../shared/authentication/src/auth.roles';

describe('roleGrants', () => {
  test.each([
    ['dj', { reviews: ['write'] }, true],
    ['dj', { reviews: ['manage'] }, false],
    ['musicDirector', { reviews: ['manage'] }, true],
    ['stationManager', { reviews: ['write', 'manage'] }, true],
    ['member', { reviews: ['write'] }, false],
    ['member', { reviews: ['read'] }, false],
  ] as const)('%s with %j → %s', (role, statement, expected) => {
    expect(roleGrants(role, statement)).toBe(expected);
  });

  test.each([undefined, null, '', 'toString', 'no-such-role'])('%p grants nothing', (role) => {
    expect(roleGrants(role, { reviews: ['read'] })).toBe(false);
  });
});
