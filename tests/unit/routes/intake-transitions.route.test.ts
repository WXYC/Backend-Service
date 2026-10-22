// Same real-middleware harness as intake-permissions.route.test.ts (the shared
// `@wxyc/authentication` stub ignores the permission argument).
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;
// The request route refuses an ask to an account that cannot see reviews (BS#3531); the cases below that are not about it ask a DJ, so open reviews to everyone.
process.env.REVIEWS_AUDIENCE = 'true';
delete process.env.POSTHOG_FLAGS_API_KEY;
delete process.env.POSTHOG_SECRET_KEY;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

jest.mock('@wxyc/authentication', () => ({
  ...jest.requireActual('../../../shared/authentication/src/auth.middleware'),
  ...jest.requireActual('../../../shared/authentication/src/auth.roles'),
}));

import { jest as jestGlobals } from '@jest/globals';
import { jwtVerify } from 'jose';
import express from 'express';
import request from 'supertest';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockRole = (role?: string, sub = 'caller-id') =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub, email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });

const mockTransition = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockMemberAccount =
  jestGlobals.fn<
    (
      ...args: any[]
    ) => Promise<{ roles: string[]; username: string | null; email?: string | null; capabilities?: string[] }>
  >();

jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));
const mockNotifyPass = jestGlobals.fn<(...args: any[]) => Promise<void>>();
const mockNotifyAsked = jestGlobals.fn<(...args: any[]) => Promise<void>>();
const mockNotifyDigital = jestGlobals.fn<(...args: any[]) => Promise<void>>();
jest.mock('../../../apps/backend/services/review-notices.service', () => ({
  notifyPass: mockNotifyPass,
  notifyAsked: mockNotifyAsked,
  notifyDigitalTaken: mockNotifyDigital,
}));
jest.mock('../../../apps/backend/services/intake.service', () => ({
  transitionIntakeItem: mockTransition,
  memberAccount: mockMemberAccount,
}));

// The controller imports the filing seam (BS#2803), whose service module reads real schema tables at load.
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));
// The controller imports the print seam (BS#2804), whose service module reads real schema tables at load.
jest.mock('../../../apps/backend/services/review-print.service', () => ({}));

import { intake_route } from '../../../apps/backend/routes/intake.route';
import type { IntakeRequestRefusedError } from '../../../apps/backend/controllers/intake.controller';
import { resetFeatureAccess } from '../../../apps/backend/config/featureAccess';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/intake', intake_route);
app.use(errorHandler);

const ITEM = { id: 7, state: 'checked_out', effective_state: 'checked_out' };
const post = (path: string, body?: object) =>
  request(app)
    .post(`/intake/7/${path}`)
    .set('Authorization', 'Bearer t')
    .send(body ?? {});

// route → [action the service is asked for, roles that pass the route's grant]
const ROUTES = [
  ['checkout', 'checkout', ['dj', 'musicDirector', 'stationManager']],
  ['release', 'release', ['dj', 'musicDirector', 'stationManager']],
  ['request', 'request', ['musicDirector', 'stationManager']],
  ['cancel-request', 'cancel_request', ['musicDirector', 'stationManager']],
  ['accept', 'accept', ['dj', 'musicDirector', 'stationManager']],
  ['pass', 'pass', ['dj', 'musicDirector', 'stationManager']],
] as const;
const refused = (allowed: readonly string[]) =>
  ['member', 'dj', 'musicDirector', 'stationManager'].filter((r) => !allowed.includes(r));

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockTransition.mockReset().mockResolvedValue({ outcome: 'updated', item: ITEM, answeredRequest: true });
  mockMemberAccount.mockReset().mockResolvedValue({ roles: ['dj'], username: 'test.dj' });
  mockNotifyPass.mockReset();
  mockNotifyAsked.mockReset();
  mockNotifyDigital.mockReset();
});

describe.each(ROUTES)('POST /intake/:id/%s', (path, action, allowed) => {
  const body = path === 'request' ? { dj_id: 'dj-2' } : {};

  test.each(allowed)('%s is authorized and the service is asked for %s', async (role) => {
    mockRole(role);
    const res = await post(path, body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ITEM);
    expect(mockNotifyPass).toHaveBeenCalledTimes(action === 'pass' ? 1 : 0);
    expect(mockNotifyAsked).toHaveBeenCalledTimes(action === 'request' ? 1 : 0);
    expect(mockNotifyDigital).not.toHaveBeenCalled();
    expect(mockTransition).toHaveBeenCalledWith(
      action,
      7,
      { id: 'caller-id', manage: role !== 'dj' },
      path === 'request' ? 'dj-2' : undefined
    );
  });

  test.each([...refused(allowed), undefined])('%s is refused before any query, in any state', async (role) => {
    mockRole(role);
    expect((await post(path, body)).status).toBe(403);
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockMemberAccount).not.toHaveBeenCalled();
  });

  test('state_changed is a 409 with the closed reason', async () => {
    mockRole('stationManager');
    mockTransition.mockResolvedValue({ outcome: 'state_changed' });
    const res = await post(path, body);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('state_changed');
  });

  if (action === 'pass') {
    // A hung SES must not hold a pass that already committed.
    test('a notice that never settles does not hold the response', async () => {
      mockRole('dj');
      const item = { ...ITEM, artist_name: 'Juana Molina', album_title: 'DOGA' };
      mockTransition.mockResolvedValueOnce({ outcome: 'updated', item, answeredRequest: true });
      mockNotifyPass.mockReturnValueOnce(new Promise<void>(() => {}));
      const res = await post(path, body);
      expect([res.status, res.body]).toEqual([200, item]);
      expect(mockNotifyPass).toHaveBeenCalledWith({ id: 7, artist: 'Juana Molina', album: 'DOGA' }, 'caller-id');
    }, 2000);
  }

  if (action === 'request') {
    // A hung SES must not hold a request that already committed (BS#3385).
    test('an asked notice that never settles does not hold the response', async () => {
      mockRole('musicDirector');
      const item = { ...ITEM, artist_name: 'Juana Molina', album_title: 'DOGA' };
      mockTransition.mockResolvedValueOnce({ outcome: 'updated', item });
      mockNotifyAsked.mockReturnValueOnce(new Promise<void>(() => {}));
      const res = await post(path, body);
      expect([res.status, res.body]).toEqual([200, item]);
      expect(mockNotifyAsked).toHaveBeenCalledWith(
        { id: 7, artist: 'Juana Molina', album: 'DOGA' },
        'dj-2',
        'caller-id'
      );
    }, 2000);
  }

  // A digital item (BS#3102) is taken only by checkout and accept; nothing else may start the notice.
  const takes = action === 'checkout' || action === 'accept';
  test(`${takes ? 'starts' : 'never starts'} the digital notice for an updated digital item`, async () => {
    mockRole('stationManager');
    const item = { ...ITEM, artist_name: 'Juana Molina', album_title: 'DOGA', digital: true };
    mockTransition.mockResolvedValueOnce({ outcome: 'updated', item, answeredRequest: true });
    const res = await post(path, body);
    expect([res.status, res.body]).toEqual([200, item]);
    expect(mockNotifyDigital).toHaveBeenCalledTimes(takes ? 1 : 0);
    if (takes) {
      expect(mockNotifyDigital).toHaveBeenCalledWith({ id: 7, artist: 'Juana Molina', album: 'DOGA' }, 'caller-id');
    }
  });

  if (takes) {
    test('a disc sends no digital notice', async () => {
      mockRole('stationManager');
      mockTransition.mockResolvedValueOnce({
        outcome: 'updated',
        item: { ...ITEM, artist_name: 'Juana Molina', album_title: 'DOGA', digital: false },
      });
      expect((await post(path, body)).status).toBe(200);
      expect(mockNotifyDigital).not.toHaveBeenCalled();
    });

    // A hung SES must not hold a take that already committed.
    test('a digital notice that never settles does not hold the response', async () => {
      mockRole('dj');
      const item = { ...ITEM, artist_name: 'Juana Molina', album_title: 'DOGA', digital: true };
      mockTransition.mockResolvedValueOnce({ outcome: 'updated', item, answeredRequest: true });
      mockNotifyDigital.mockReturnValueOnce(new Promise<void>(() => {}));
      const res = await post(path, body);
      expect([res.status, res.body]).toEqual([200, item]);
      expect(mockNotifyDigital).toHaveBeenCalledWith({ id: 7, artist: 'Juana Molina', album: 'DOGA' }, 'caller-id');
    }, 2000);
  }

  test('a missing item is a 404', async () => {
    mockRole('stationManager');
    mockTransition.mockResolvedValue({ outcome: 'not_found' });
    expect((await post(path, body)).status).toBe(404);
  });

  test('an id past int4 is a 400 before any query', async () => {
    mockRole('stationManager');
    const res = await request(app).post(`/intake/2147483648/${path}`).set('Authorization', 'Bearer t').send(body);
    expect(res.status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });
});

describe('identity refusals', () => {
  // A DJ who is not the requested DJ, or not the holder, when the item IS in the right state.
  test.each(['release', 'accept', 'pass'])('%s by a DJ the item does not belong to is a 403', async (path) => {
    mockRole('dj');
    mockTransition.mockResolvedValue({ outcome: 'forbidden' });
    expect((await post(path)).status).toBe(403);
  });

  test('release is asked for with manage false for a DJ, so the holder condition applies', async () => {
    mockRole('dj');
    await post('release');
    expect(mockTransition).toHaveBeenCalledWith('release', 7, { id: 'caller-id', manage: false }, undefined);
  });

  test('release is asked for with manage true for a music director, lifting the holder condition', async () => {
    mockRole('musicDirector');
    await post('release');
    expect(mockTransition).toHaveBeenCalledWith('release', 7, { id: 'caller-id', manage: true }, undefined);
  });
});

describe('POST /intake/:id/request — dj_id', () => {
  beforeEach(() => mockRole('musicDirector'));

  test.each([
    ['missing', {}],
    ['a non-string', { dj_id: 42 }],
    ['an empty string', { dj_id: '' }],
  ])('%s is a 400 and changes nothing', async (_n, body) => {
    expect((await post('request', body)).status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test('an unknown account (no membership) is a 400 and changes nothing', async () => {
    mockMemberAccount.mockResolvedValue({ roles: [], username: null });
    expect((await post('request', { dj_id: 'ghost' })).status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test('a member (reviews: []) is a 400 and changes nothing', async () => {
    mockMemberAccount.mockResolvedValue({ roles: ['member'], username: 'test.member' });
    expect((await post('request', { dj_id: 'm-1' })).status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test.each([
    ['the auto-DJ', { roles: ['dj'], username: 'autodj', email: 'autodj@example.org' }],
    ['the uptime canary', { roles: ['dj'], username: 'test.canary', email: 'canary@wxyc.org' }],
  ])(
    '%s service account is the same 400, with the same body and no new reason, and changes nothing',
    async (_label, account) => {
      mockMemberAccount.mockResolvedValue({
        roles: ['member'],
        username: 'test.member',
        email: 'test.member@example.org',
      });
      const member = await post('request', { dj_id: 'm-1' });
      expect(member.body).toEqual(expect.objectContaining({ message: 'dj_id must name an account that can review' }));
      mockMemberAccount.mockResolvedValue(account);
      const res = await post('request', { dj_id: 'svc-1' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(member.body);
      expect(mockTransition).not.toHaveBeenCalled();
    }
  );

  test('a DJ is a 200', async () => {
    mockMemberAccount.mockResolvedValue({ roles: ['dj'], username: 'test.dj' });
    expect((await post('request', { dj_id: 'dj-2' })).status).toBe(200);
    expect(mockMemberAccount).toHaveBeenCalledWith('dj-2');
  });
});

// BS#3531: an ask is refused exactly when the asked account cannot see reviews now (`canAccess('reviews', asked)`).
// Compile-time pin: the controller's `IntakeRequestRefusedError` mirror must equal wxyc-shared api.yaml's schema (`message`, and
// `code` the one-value `IntakeRequestRefusedCode` enum); `@wxyc/shared` 5.4.0 predates it, so the SSOT shape is written out here.
type ApiYamlIntakeRequestRefusedError = { message: string; code: 'asked_dj_cannot_see_feature' };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _RefusalMatchesSsot = Expect<Equal<IntakeRequestRefusedError, ApiYamlIntakeRequestRefusedError>>;
const REFUSAL: ApiYamlIntakeRequestRefusedError = {
  message: "This DJ can't see reviews yet. A station manager can add them to the reviews beta in the DJ Roster.",
  code: 'asked_dj_cannot_see_feature',
};

describe('POST /intake/:id/request — the asked account must be able to see reviews', () => {
  beforeEach(() => {
    mockRole('musicDirector');
    resetFeatureAccess();
  });
  afterAll(() => {
    process.env.REVIEWS_AUDIENCE = 'true';
    resetFeatureAccess();
  });

  // All 18 rows: audience x role x capabilities. The rule is written out here, not read from `canAccess`: off refuses
  // everyone; staff refuses a DJ without the beta; everyone refuses nobody who can review.
  const AUDIENCES = ['off', 'staff', 'everyone'];
  const ROLES = ['dj', 'musicDirector', 'stationManager'];
  const CAPABILITIES: string[][] = [[], ['reviews_beta']];
  const refusedAt = (audience: string, role: string, capabilities: string[]) =>
    audience === 'off' || (audience === 'staff' && role === 'dj' && !capabilities.includes('reviews_beta'));
  const CASES: [string, string, string[], boolean][] = AUDIENCES.flatMap((audience) =>
    ROLES.flatMap((role) =>
      CAPABILITIES.map((capabilities): [string, string, string[], boolean] => [
        audience,
        role,
        capabilities,
        refusedAt(audience, role, capabilities),
      ])
    )
  );
  test.each(CASES)('audience %s, asked %s holding %j: refused %s', async (audience, role, capabilities, isRefused) => {
    // `REVIEWS_AUDIENCE` spells everyone as `true`.
    process.env.REVIEWS_AUDIENCE = audience === 'everyone' ? 'true' : audience;
    mockMemberAccount.mockResolvedValue({
      roles: [role],
      username: 'test.dj',
      email: 'test.dj@example.org',
      capabilities,
    });
    const res = await post('request', { dj_id: 'dj-2' });
    if (isRefused) {
      expect([res.status, res.body]).toEqual([400, REFUSAL]);
      expect(res.body).not.toHaveProperty('reason');
      expect(mockTransition).not.toHaveBeenCalled();
      expect(mockNotifyAsked).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(200);
      expect(mockTransition).toHaveBeenCalledTimes(1);
    }
  });

  test('judges the asked account by its highest role, not the first one listed', async () => {
    process.env.REVIEWS_AUDIENCE = 'staff';
    mockMemberAccount.mockResolvedValue({
      roles: ['dj', 'musicDirector'],
      username: 'test.md',
      email: 'md@example.org',
      capabilities: [],
    });
    expect((await post('request', { dj_id: 'dj-2' })).status).toBe(200);
  });

  test('an account that cannot review keeps the existing 400, ahead of the audience check', async () => {
    process.env.REVIEWS_AUDIENCE = 'off';
    mockMemberAccount.mockResolvedValue({
      roles: ['member'],
      username: 'test.member',
      email: 'm@example.org',
      capabilities: [],
    });
    const res = await post('request', { dj_id: 'm-1' });
    expect(res.body).toEqual(expect.objectContaining({ message: 'dj_id must name an account that can review' }));
  });
});
