jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.roles'));

import { canBeAskedToReview, canWriteReviews, reviewsActor } from '../../../apps/backend/utils/review-grants';

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

describe('canBeAskedToReview (the one account rule behind /intake dj_id and GET /reviews/reviewers)', () => {
  test.each([
    ['a dj', ['dj'], 'test.dj', true],
    ['a dj with no username', ['dj'], null, true],
    ['a member', ['member'], 'test.member', false],
    ['the auto-DJ service account (dj role)', ['dj'], 'autodj', false],
    ['the auto-DJ service account (any role)', ['musicDirector'], 'autodj', false],
    ['a username that merely contains autodj', ['dj'], 'autodj2', true],
  ])('%s is %s', (_label, roles, username, expected) => {
    expect(canBeAskedToReview({ roles, username })).toBe(expected);
  });
});
