/**
 * The WXYC rotation bins, and the one parser every writer of `rotation_bin`
 * should go through.
 *
 * This module is deliberately PURE — no drizzle, no schema import, no db
 * handle — for two reasons. `schema.ts` calls drizzle's `eq` at module scope,
 * so `tests/mocks/database.mock.ts` cannot import it and instead re-exports
 * pure `shared/database/src/*` modules directly (see `env-parsers`,
 * `fold-artist-name`, `ny-time`). And `jobs/**` is a separate workspace that
 * depends on `@wxyc/database` but not `@wxyc/shared`, so this is the only home
 * reachable from every call site.
 *
 * `freqEnum` in schema.ts is DERIVED from `ROTATION_BINS` rather than
 * duplicating it, so the Postgres enum and the TypeScript union cannot drift.
 * BS#2173 is what that guards against: a fifth member `'N'` was added to the
 * enum in migration 0041 and had to be removed from eleven hand-written copies.
 */

/**
 * Singles, Light, Medium, Heavy — exactly the four radio buttons tubafrenzy's
 * rotation-release form offers, and the only values `ROTATION_TYPE` has ever
 * held besides the empty string.
 *
 * Order is `freq_enum`'s DECLARATION order (lightest to heaviest), which is
 * load-bearing in two places: Postgres sorts the enum by it, and
 * `library-search.service.ts` re-exports this array to render a user-facing
 * error string. It is NOT weight order — see `ROTATION_BIN_DEDUP_ORDINAL`,
 * which deliberately keeps its own ordering.
 */
export const ROTATION_BINS = ['S', 'L', 'M', 'H'] as const;

export type RotationBin = (typeof ROTATION_BINS)[number];

/**
 * The three states an inbound `rotation_bin` can be in. Callers share this
 * classification but keep their own policy, because "no bin supplied" means
 * genuinely different things to different writers: to the rotation webhook it
 * is a linkage-only partial update (BS#1082/#1312), to the ETL it is a release
 * to skip, and to `POST /library/rotation` it is a missing required field.
 *
 * Keeping `missing` and `invalid` distinct is the point. Collapsing them —
 * which an earlier version of the ETL did — silently swallows genuine bad data
 * (`ROTATION_TYPE = 'XYZ'`) under a log line that says "no bin upstream".
 */
export type RotationBinParse =
  { kind: 'bin'; bin: RotationBin } | { kind: 'missing' } | { kind: 'invalid'; raw: unknown };

/**
 * Classify a raw `rotation_bin` from any inbound source.
 *
 * Absent, null, and blank all classify as `missing`. That is not defensive
 * over-reach: tubafrenzy's `BackendServiceWebhookClient.buildRotationPayload`
 * serializes a null `ROTATION_TYPE` as the empty string rather than omitting
 * the key, so `""` is a real wire form meaning "this release has no bin
 * upstream" — and it is the form that actually occurs, since the releases with
 * a blank `ROTATION_TYPE` are exactly the ones migration 0150 reclassifies.
 *
 * Non-strings are stringified rather than classified as `missing`, so a
 * payload like `{"rotationType": 7}` is reported as bad data instead of
 * silently taking a caller's no-bin path.
 */
export function parseRotationBin(raw: unknown): RotationBinParse {
  const normalized = typeof raw === 'string' ? raw.trim().toUpperCase() : String(raw ?? '');
  if (normalized === '') return { kind: 'missing' };
  const bin = (ROTATION_BINS as readonly string[]).includes(normalized) ? (normalized as RotationBin) : undefined;
  return bin ? { kind: 'bin', bin } : { kind: 'invalid', raw };
}
