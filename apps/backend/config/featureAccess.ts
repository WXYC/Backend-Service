import { PostHog } from 'posthog-node';
import { Authorization, roleToAuthorization } from '@wxyc/authentication';
import { getErrorReporter } from '@wxyc/observability';
import { parseAudience, type ReviewsAudience } from './reviewsAudience.js';

/**
 * Feature access (BS#3529, epic BS#3528): the features still opening to the station, each with an audience read from a
 * runtime PostHog flag, and one rule, `canAccess`, for who may use one. `flag` is the PostHog flag key; `capability`
 * (optional, BS#3535 drops it) lets a named tester below music director see the feature while it is `staff`; `envFallback`
 * names the env var read, with `parseAudience`'s spellings, when PostHog does not answer. Capabilities are plain strings
 * because Backend-Service is pinned to `@wxyc/shared` 5.4.0.
 */
export const FEATURES = {
  reviews: { flag: 'reviews-audience', capability: 'reviews_beta', envFallback: 'REVIEWS_AUDIENCE' },
} as const satisfies Record<string, { flag: string; capability?: string; envFallback: string }>;

export type FeatureKey = keyof typeof FEATURES;
export type Audience = ReviewsAudience;

/** An account as `canAccess` sees it: its better-auth role (any string, or none) and the capabilities it holds. */
export interface FeatureAccount {
  role?: string | null;
  capabilities?: readonly string[];
}

const AUDIENCES: readonly unknown[] = ['off', 'staff', 'everyone'];
/** The flag has no person targeting, so it is evaluated for one fixed id and never a person's. */
const FLAG_DISTINCT_ID = 'backend-service';
const POLL_INTERVAL_MS = 60_000;
/** The first load starts at construction; a flag still not loaded after one poll interval is reported. */
const LOAD_GRACE_MS = POLL_INTERVAL_MS;
const REPORT_AGAIN_MS = 60 * 60 * 1000;

type FlagState = 'present' | 'missing' | 'not_loaded' | 'error' | 'stale';

let flagClient: { client: PostHog | null; builtAt: number; failed: boolean } | null = null;
/**
 * Set when a definitions poll fails after posthog-node holds definitions (a revoked key's 401 or 403, a 429 backoff): the
 * library then keeps serving the last definitions and reports the failure only through its 'error' event. Cleared by its
 * 'localEvaluationFlagsLoaded' event, which fires when a poll brings changed definitions (a 304 fires nothing).
 */
let pollFailing = false;
const reported = new Map<string, { state: FlagState; at: number }>();

/**
 * The one flag client of the process, kept apart from the capture-only singleton in `utils/posthog.ts` because the flags
 * live in the dj-site PostHog project, not the one `POSTHOG_API_KEY` names. With no token or no secret key it is null
 * and no poller exists. Local evaluation polls every minute: an unchanged poll costs one flag request, and nothing is
 * evaluated remotely (the removed `isMirrorEnabled` made a billed round trip per check).
 */
const getFlagClient = (): PostHog | null => {
  if (!flagClient) {
    const { POSTHOG_FLAGS_API_KEY: token, POSTHOG_SECRET_KEY: secretKey } = process.env;
    let client: PostHog | null = null;
    let failed = false;
    try {
      // posthog-node throws synchronously on a bad key (a `phc_` token in the secret slot, say); remember that rather than rebuild on every call.
      client =
        token && secretKey
          ? new PostHog(token, {
              host: 'https://us.i.posthog.com',
              secretKey,
              featureFlagsPollingInterval: POLL_INTERVAL_MS,
              strictLocalEvaluation: true,
            })
          : null;
    } catch {
      failed = true;
    }
    client?.on('error', () => {
      pollFailing = true;
    });
    client?.on('localEvaluationFlagsLoaded', () => {
      pollFailing = false;
    });
    flagClient = { client, builtAt: Date.now(), failed };
  }
  return flagClient.client;
};

/** Builds the flag client now (apps/backend start-up), so the first poll is not on a request path. Never throws. */
export const warmFeatureAccess = (): void => {
  getFlagClient();
};

/** Tests only: drop the flag client and the warning state, so the next call re-reads the env. */
export const resetFeatureAccess = (): void => {
  void flagClient?.client?.shutdown();
  flagClient = null;
  pollFailing = false;
  reported.clear();
};

/** Warns through the `ErrorReporter` when the flag is not in the loaded definitions, or none loaded: once per state, then hourly. */
const reportFlagState = (flag: string, state: FlagState): void => {
  const last = reported.get(flag);
  if (state === 'present') {
    reported.delete(flag);
    return;
  }
  const now = Date.now();
  if (state === 'not_loaded' && now - (flagClient?.builtAt ?? now) < LOAD_GRACE_MS) {
    return;
  }
  if (last?.state === state && now - last.at < REPORT_AGAIN_MS) {
    return;
  }
  reported.set(flag, { state, at: now });
  try {
    getErrorReporter().captureMessage(
      state === 'error'
        ? `PostHog flag client failed for "${flag}" (a bad POSTHOG_FLAGS_API_KEY or POSTHOG_SECRET_KEY, such as the two swapped, or an unexpected client error); it falls back to its env var`
        : state === 'stale'
          ? `PostHog flag definitions have stopped refreshing (a revoked or wrong key, rate limiting, or an outage); "${flag}" keeps the last value it loaded, so a flag change in PostHog is not taking effect; fix the keys, or recreate the backend container`
          : state === 'missing'
            ? `PostHog flag "${flag}" is not usable from the loaded definitions: it may be absent, the keys may name a project that holds no flags, or the flag may not be locally evaluable; check POSTHOG_FLAGS_API_KEY and POSTHOG_SECRET_KEY, and that the flag has no experience continuity or unknown group type; it falls back to its env var`
            : `PostHog flag definitions are not ready: they may not have loaded yet (network, a revoked key) or the project may hold no flags; "${flag}" falls back to its env var`,
      { level: 'warning', tags: { subsystem: 'feature-access' } }
    );
  } catch {
    // Reporting must never break an access check.
  }
};

/**
 * `getAllFlags`, not `evaluateFlags`: reading a value off an `evaluateFlags` snapshot always queues a
 * `$feature_flag_called` event, with no opt-out, and this client has no business capturing events.
 */
const readFlag = async (flag: string): Promise<Audience | undefined> => {
  const posthog = getFlagClient();
  if (!posthog) {
    if (flagClient?.failed) {
      reportFlagState(flag, 'error');
    }
    return undefined;
  }
  try {
    if (!posthog.isLocalEvaluationReady()) {
      // Straight to the env fallback: getAllFlags would wait on a definitions fetch (up to 10 s) before saying the same. The poller retries on its own timer.
      reportFlagState(flag, 'not_loaded');
      return undefined;
    }
    const flags = await posthog.getAllFlags(FLAG_DISTINCT_ID, { flagKeys: [flag], onlyEvaluateLocally: true });
    reportFlagState(flag, flag in flags ? (pollFailing ? 'stale' : 'present') : 'missing');
    const value = flags[flag];
    return AUDIENCES.includes(value) ? (value as Audience) : undefined;
  } catch {
    reportFlagState(flag, 'error');
    return undefined;
  }
};

/** Who a feature is open to: the PostHog flag's variant when local evaluation has one of the three, else the env fallback, else `off` (fails closed). */
export const audience = async (feature: FeatureKey): Promise<Audience> => {
  const { flag, envFallback } = FEATURES[feature];
  return (await readFlag(flag)) ?? parseAudience(process.env[envFallback]);
};

/**
 * Whether `account` may use `feature` when it is open to `at`. No account below DJ ever may, whatever the audience or capability: `staff` opens it
 * to music directors and above, or to an account holding the feature's capability; `everyone` to DJs and above. Pure, so a caller that
 * already holds the audience (`GET /feature-access`) decides from that same read.
 */
export const accessAt = (at: Audience, feature: FeatureKey, account: FeatureAccount): boolean => {
  const level = roleToAuthorization(account.role ?? undefined);
  if (level < Authorization.DJ) {
    return false;
  }
  const { capability } = FEATURES[feature] as { capability?: string };
  switch (at) {
    case 'everyone':
      return true;
    case 'staff':
      return (
        level >= Authorization.MD || (capability !== undefined && (account.capabilities?.includes(capability) ?? false))
      );
    default:
      return false;
  }
};

/** Whether `account` may use `feature` now: `accessAt` over the audience read this once. */
export const canAccess = async (feature: FeatureKey, account: FeatureAccount): Promise<boolean> =>
  accessAt(await audience(feature), feature, account);
