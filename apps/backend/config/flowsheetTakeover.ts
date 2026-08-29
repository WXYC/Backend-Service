/**
 * Configuration for `POST /flowsheet/join`'s explicit start-vs-join decision
 * (BS#2233, epic BS#2232).
 *
 * When enabled, a caller who presses "Go Live" while a show they are not an
 * active member of is still open must say what they mean: `intent: "join"`
 * co-hosts, `intent: "takeover"` closes the open show and starts their own,
 * and no `intent` at all is a 409 carrying the open show's details. When
 * disabled, `intent` and `expected_show_id` are ignored entirely and the
 * route behaves exactly as it did before — the silent co-host attachment,
 * including its bug.
 *
 * **Flag-OFF must never 400 or 409.** That is not a nicety, it is the
 * rollout: `auto-dj-orchestrator` ships `intent: "takeover"` before the flip,
 * and its `join()` throws on any response body without a show id
 * (`src/backend/flowsheet-client.ts`), so a 400 on the unrecognized field
 * would crash that daemon at activation. Ordering accidents between the four
 * repos in this chain are therefore harmless: BS ships dormant, every client
 * becomes 409-aware while nothing is sending 409s, and the flip is one env
 * var. The flag is also the rollback — no redeploy.
 *
 * Deliberately does NOT reuse the mirror's `isMirrorEnabled`, which
 * env-defaults to `true` when `POSTHOG_API_KEY` is unset
 * (`middleware/legacy/mirror.middleware.ts`). Copying that shape would make
 * this flag default ON in every environment without a PostHog key — including
 * the dj-site e2e stack, which sets none — the exact inverse of shipping
 * dormant.
 *
 * The singleton mechanics (strict-`true` parse, lazy cache, `resetConfig` test
 * hook) come from the shared {@link createEnvFlagConfig} factory. Tests that
 * mutate `process.env.FLOWSHEET_TAKEOVER_ENABLED` between cases must call
 * `resetConfig()` so the next `getConfig()` re-reads the env.
 */
import { createEnvFlagConfig, type EnvFlagConfig } from './envFlag.js';

export type FlowsheetTakeoverConfig = EnvFlagConfig;

export const { loadConfig, getConfig, resetConfig } = createEnvFlagConfig('FLOWSHEET_TAKEOVER_ENABLED');
