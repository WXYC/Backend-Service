/**
 * Configuration for the digital-archive playback endpoint (BS#2320, epic
 * WXYC/wxyc-dj-ios#135).
 *
 * Two independent settings, which is why this is NOT `createEnvFlagConfig`
 * (that factory returns `{ enabled }` only — see its own doc comment for the
 * "one setting" scope it's meant for). Modeled on
 * `apps/backend/config/catalogSearchAlias.ts`.
 *
 * `enabled` gates `GET /digital-archive/albums/:id/playback` (403 when off,
 * checked BEFORE any DB read — see the controller) and forces
 * `has_digital_audio` to `false` on every `GET /library/catalog` row
 * (`catalog-export.service.ts`) regardless of what `digital_asset` holds.
 * Defaults to `false` so production behavior is unchanged until an operator
 * opts in via `docs/env-vars.md`'s light-up procedure.
 *
 * Tests that mutate either env var between cases must call `resetConfig()`
 * in `beforeEach` so the next `getConfig()` re-reads the environment.
 */

/** Default presigned-URL lifetime: 4 hours — long enough to outlast a full LP side. */
export const DEFAULT_SIGN_TTL_SECONDS = 14400;

/** Ceiling on `signTTLSeconds`: 7 days. A presigned URL is a bearer credential
 * until it expires, so an operator override cannot mint one that outlives a week. */
export const MAX_SIGN_TTL_SECONDS = 604800;

export interface DigitalArchiveConfig {
  /** Strict-`true` gate on the whole digital-archive playback surface. */
  enabled: boolean;

  /** Lifetime, in seconds, of each presigned rendition URL a manifest carries. */
  signTTLSeconds: number;
}

/**
 * Parse the TTL from its env var. An unusable value falls back to the
 * default rather than throwing — a malformed operator override must degrade
 * the feature to its shipped default, not take the endpoint down.
 *
 * A value above the ceiling is clamped rather than rejected: an operator who
 * asks for "as long as possible" gets the longest lifetime this service is
 * willing to mint, not an error.
 */
function parseSignTTLSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SIGN_TTL_SECONDS;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[digitalArchive] DIGITAL_ARCHIVE_SIGN_TTL_SECONDS=${JSON.stringify(raw)} is not a positive integer; ` +
        `falling back to ${DEFAULT_SIGN_TTL_SECONDS}.`
    );
    return DEFAULT_SIGN_TTL_SECONDS;
  }
  if (parsed > MAX_SIGN_TTL_SECONDS) {
    console.warn(
      `[digitalArchive] DIGITAL_ARCHIVE_SIGN_TTL_SECONDS=${parsed} exceeds the ${MAX_SIGN_TTL_SECONDS}s ceiling; ` +
        `clamping to it.`
    );
    return MAX_SIGN_TTL_SECONDS;
  }
  return parsed;
}

/** Read the config fresh from the environment. */
export function loadConfig(): DigitalArchiveConfig {
  return {
    enabled: process.env.DIGITAL_ARCHIVE_STREAMING_ENABLED === 'true',
    signTTLSeconds: parseSignTTLSeconds(process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS),
  };
}

let _config: DigitalArchiveConfig | null = null;

export function getConfig(): DigitalArchiveConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** Drop the cached singleton so the next `getConfig()` re-reads the env. */
export function resetConfig(): void {
  _config = null;
}
