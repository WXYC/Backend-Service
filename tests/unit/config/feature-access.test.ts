/**
 * Unit tests for the feature-access seam (BS#3529, epic BS#3528): `audience(feature)` takes the PostHog flag's
 * variant when local evaluation answers with one of the three audiences, else the env fallback, else `off`; and
 * `canAccess(feature, account)` applies one rule over that audience, the account's role and its capabilities.
 * The flag client is a mocked posthog-node, so nothing here reaches the network.
 */
const mockGetAllFlags = jest.fn();
const mockIsReady = jest.fn();
const mockPostHog = jest.fn();
const mockCaptureMessage = jest.fn();
const handlers: Record<string, () => void> = {};

jest.mock('posthog-node', () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      mockPostHog(...args);
    }
    getAllFlags = mockGetAllFlags;
    isLocalEvaluationReady = mockIsReady;
    shutdown = jest.fn();
    on = (event: string, handler: () => void) => {
      handlers[event] = handler;
    };
  },
}));
jest.mock('@wxyc/observability', () => ({
  getErrorReporter: () => ({ captureMessage: mockCaptureMessage }),
}));
jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.roles'));

import { audience, canAccess, resetFeatureAccess } from '../../../apps/backend/config/featureAccess';

const ENV_KEYS = ['POSTHOG_FLAGS_API_KEY', 'POSTHOG_SECRET_KEY', 'POSTHOG_API_KEY', 'REVIEWS_AUDIENCE'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const setEnv = (key: (typeof ENV_KEYS)[number], value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

/** What local evaluation answers: no key, definitions not loaded, the flag absent, or the flag with a value. */
type PostHogState = 'no key' | 'not loaded' | 'flag missing' | { returns: unknown };

const givenPostHog = (state: PostHogState) => {
  if (state === 'no key') {
    return;
  }
  setEnv('POSTHOG_FLAGS_API_KEY', 'phc_flags');
  setEnv('POSTHOG_SECRET_KEY', 'phs_secret');
  mockIsReady.mockReturnValue(state !== 'not loaded');
  mockGetAllFlags.mockResolvedValue(typeof state === 'object' ? { 'reviews-audience': state.returns } : {});
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  for (const key of ENV_KEYS) {
    setEnv(key, undefined);
  }
  resetFeatureAccess();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    setEnv(key, saved[key]);
  }
});

describe('audience(reviews)', () => {
  // PostHog wins when it returns a known value; otherwise the env fallback decides; otherwise off.
  const envReads: [string | undefined, string][] = [
    [undefined, 'off'],
    ['staff', 'staff'],
    ['true', 'everyone'],
    ['1', 'everyone'],
    ['TRUE', 'off'],
    ['yes', 'off'],
  ];
  const posthogStates: [string, PostHogState, string | null][] = [
    ['no key', 'no key', null],
    ['definitions not loaded', 'not loaded', null],
    ['flag missing', 'flag missing', null],
    ['flag returns off', { returns: 'off' }, 'off'],
    ['flag returns staff', { returns: 'staff' }, 'staff'],
    ['flag returns everyone', { returns: 'everyone' }, 'everyone'],
    ['flag returns an unknown variant', { returns: 'beta' }, null],
    ['flag returns true', { returns: true }, null],
    ['flag returns false', { returns: false }, null],
  ];
  const cases = posthogStates.flatMap(([label, state, flagValue]) =>
    envReads.map(([env, envAudience]) => [label, state, env, flagValue ?? envAudience] as const)
  );

  it.each(cases)('with PostHog %s and REVIEWS_AUDIENCE=%p reads %p', async (_label, state, env, expected) => {
    givenPostHog(state);
    setEnv('REVIEWS_AUDIENCE', env);
    expect(await audience('reviews')).toBe(expected);
  });

  it.each([
    ['POSTHOG_FLAGS_API_KEY', 'POSTHOG_SECRET_KEY'],
    ['POSTHOG_SECRET_KEY', 'POSTHOG_FLAGS_API_KEY'],
  ] as const)('builds no client, and falls back to the env, when only %s is set (not %s)', async (present, _absent) => {
    setEnv(present, 'x');
    setEnv('POSTHOG_API_KEY', 'phc_capture');
    setEnv('REVIEWS_AUDIENCE', 'staff');
    expect(await audience('reviews')).toBe('staff');
    expect(mockPostHog).not.toHaveBeenCalled();
  });

  it('builds the flag client once, on the flag token and the secret key, never on POSTHOG_API_KEY, and evaluates locally only', async () => {
    givenPostHog({ returns: 'staff' });
    setEnv('POSTHOG_API_KEY', 'phc_capture');
    await audience('reviews');
    await audience('reviews');
    expect(mockPostHog).toHaveBeenCalledTimes(1);
    expect(mockPostHog).toHaveBeenCalledWith(
      'phc_flags',
      expect.objectContaining({
        secretKey: 'phs_secret',
        featureFlagsPollingInterval: 60000,
        strictLocalEvaluation: true,
      })
    );
    expect(mockGetAllFlags).toHaveBeenCalledWith('backend-service', {
      flagKeys: ['reviews-audience'],
      onlyEvaluateLocally: true,
    });
  });
});

describe('canAccess(reviews)', () => {
  const ROLES = ['member', 'dj', 'musicDirector', 'stationManager', undefined, 'editor'] as const;
  const CAPABILITIES = [[], ['reviews_beta'], ['editor']] as const;
  const open = (role: string | undefined) => role === 'dj' || role === 'musicDirector' || role === 'stationManager';
  const atLeastMusicDirector = (role: string | undefined) => role === 'musicDirector' || role === 'stationManager';

  const cases = ROLES.flatMap((role) =>
    CAPABILITIES.map((capabilities) => {
      const holdsCapability = capabilities.some((c) => c === 'reviews_beta');
      return {
        role,
        capabilities,
        off: false,
        staff: open(role) && (atLeastMusicDirector(role) || holdsCapability),
        everyone: open(role),
      };
    })
  );

  it.each(cases.flatMap((c) => (['off', 'staff', 'everyone'] as const).map((a) => [a, c] as const)))(
    'at audience %s: %j',
    async (a, { role, capabilities, ...expected }) => {
      givenPostHog({ returns: a });
      expect(await canAccess('reviews', { role, capabilities })).toBe(expected[a]);
    }
  );

  it('treats an account with no capabilities listed as holding none', async () => {
    givenPostHog({ returns: 'staff' });
    expect(await canAccess('reviews', { role: 'dj' })).toBe(false);
  });
});

describe('the missing-flag warning', () => {
  const HOUR = 60 * 60 * 1000;
  const GRACE = 60 * 1000;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-21T12:00:00-07:00') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports a flag missing from loaded definitions once, not on every check', async () => {
    givenPostHog('flag missing');
    for (let i = 0; i < 5; i++) {
      await audience('reviews');
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('reviews-audience'),
      expect.objectContaining({ level: 'warning', tags: { subsystem: 'feature-access' } })
    );
  });

  it('reports again on a slow period, and again when the state changes', async () => {
    givenPostHog('flag missing');
    await audience('reviews');
    jest.setSystemTime(Date.now() + HOUR + 1);
    await audience('reviews');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);

    givenPostHog('not loaded');
    jest.setSystemTime(Date.now() + GRACE + 1);
    await audience('reviews');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(3);
  });

  it('stays quiet while the first load is still within its grace period, and reports once it overruns', async () => {
    givenPostHog('not loaded');
    await audience('reviews');
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    jest.setSystemTime(Date.now() + GRACE + 1);
    await audience('reviews');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('reports a flag again after it came back and went missing', async () => {
    givenPostHog('flag missing');
    await audience('reviews');
    givenPostHog({ returns: 'staff' });
    await audience('reviews');
    givenPostHog('flag missing');
    await audience('reviews');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it.each(['no key', { returns: 'staff' }, { returns: false }] as const)(
    'stays quiet when PostHog is %j',
    async (state) => {
      givenPostHog(state);
      await audience('reviews');
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    }
  );
});

describe('the stale-definitions warning', () => {
  it('reports a poll failure after a successful load once, keeps the loaded value, and clears when definitions load again', async () => {
    setEnv('REVIEWS_AUDIENCE', 'off');
    givenPostHog({ returns: 'everyone' });
    await audience('reviews');
    handlers.error();
    for (let i = 0; i < 3; i++) {
      await expect(audience('reviews')).resolves.toBe('everyone');
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('stopped refreshing'),
      expect.objectContaining({ level: 'warning' })
    );
    handlers.localEvaluationFlagsLoaded();
    await audience('reviews');
    handlers.error();
    await audience('reviews');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });
});

describe('a PostHog failure fails closed', () => {
  beforeEach(() => {
    setEnv('REVIEWS_AUDIENCE', 'staff');
  });

  it('falls back to the env value and reports once when the client cannot be built', async () => {
    givenPostHog({ returns: 'everyone' });
    mockPostHog.mockImplementation(() => {
      throw new Error('Your Personal API key is invalid');
    });
    for (let i = 0; i < 3; i++) {
      await expect(audience('reviews')).resolves.toBe('staff');
    }
    expect(mockPostHog).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('goes straight to the env value without calling getAllFlags while definitions are not ready', async () => {
    givenPostHog('not loaded');
    await expect(audience('reviews')).resolves.toBe('staff');
    expect(mockGetAllFlags).not.toHaveBeenCalled();
  });

  it('falls back to the env value and reports once when getAllFlags throws', async () => {
    givenPostHog({ returns: 'everyone' });
    mockGetAllFlags.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 3; i++) {
      await expect(audience('reviews')).resolves.toBe('staff');
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });
});
