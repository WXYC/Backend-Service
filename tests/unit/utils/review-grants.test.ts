jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.roles'));

import { canWriteReviews, reviewsActor } from '../../../apps/backend/utils/review-grants';

describe('reviewsActor', () => {
  test.each([
    ['auth.id', { id: 'u1', sub: 's1', role: 'dj' }, { id: 'u1', manage: false }],
    ['auth.sub when there is no id', { sub: 's1', role: 'dj' }, { id: 's1', manage: false }],
    ['reviews: manage', { id: 'u1', role: 'musicDirector' }, { id: 'u1', manage: true }],
  ])('builds the caller from %s', (_label, auth, expected) => {
    expect(reviewsActor({ auth } as any)).toEqual(expected);
  });
});

describe('canWriteReviews (the one test behind /intake dj_id and GET /reviews/reviewers)', () => {
  test.each([
    [['dj'], true],
    [['musicDirector'], true],
    [['stationManager'], true],
    [['member', 'dj'], true],
    [['member'], false],
    [[], false],
    [[null, undefined], false],
  ])('%j is %s', (roles, expected) => {
    expect(canWriteReviews(roles)).toBe(expected);
  });
});
