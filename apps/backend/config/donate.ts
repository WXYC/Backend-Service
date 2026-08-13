/**
 * Configuration for the donate entry point served via `GET /config`
 * (WXYC/Backend-Service#2111).
 *
 * The apps ship the donate button dark and light it up once `donateEnabled`
 * flips true, so the flag is strict-`true` gated the same way the
 * `criticReviews` sibling is — an accidental `DONATE_ENABLED=1`/`TRUE`/`yes`
 * must not silently activate a fundraiser button in front of listeners.
 *
 * Ships dark: neither `DONATE_URL` nor `DONATE_ENABLED` is set on the prod
 * host as part of this change, so `GET /config` keeps returning
 * `donateUrl: ''` and `donateEnabled: false` until an operator opts in.
 * Backend-Service runs on EC2, not Railway — light-up is the
 * `set-ec2-env-var.yml` ops workflow (both keys are already in its allowlist),
 * which upserts the value into the host's `.env` and recreates the `backend`
 * container. `docker restart` is not enough: the container is started with
 * `--env-file`, which Docker re-reads only on `docker run`.
 *
 * The singleton mechanics (strict-`true` parse, lazy cache, `resetConfig`
 * test hook) come from the shared {@link createEnvFlagConfig} factory. Tests
 * that mutate `process.env.DONATE_ENABLED` between cases must call
 * `resetConfig()` in `beforeEach` so the next `getConfig()` re-reads the env.
 */
import { createEnvFlagConfig, type EnvFlagConfig } from './envFlag.js';

export type DonateConfig = EnvFlagConfig;

export const { loadConfig, getConfig, resetConfig } = createEnvFlagConfig('DONATE_ENABLED');
