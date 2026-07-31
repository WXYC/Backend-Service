/**
 * LML lookup fetcher for the library.artwork_url backfill (#637, BS#1282).
 *
 * Was a vendored `fetch()` straight to `${baseUrl()}/api/v1/lookup` — this
 * file's own header used to say it "mirrors flowsheet-metadata-backfill/
 * lml-fetch.ts near-verbatim," i.e. it duplicated logic that job had already
 * migrated onto `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint from BS#887). BS#1282 finishes that
 * consolidation: this is now a thin wrapper, matching
 * `jobs/rotation-release-id-backfill/lml-fetch.ts`'s shape.
 *
 * `opts.discogsUnavailable` threads the BS#1293 runtime-lookup gate.
 * `orchestrate.ts` pre-reads `library.discogs_unavailable` for each
 * candidate row and passes it through here — when `true`,
 * `sharedLookupMetadata` short-circuits before any HTTP call or
 * limiter/token spend and returns a `GatedLookupResponse` with
 * `outcome: 'skipped_discogs_unavailable'`, so a flagged album's
 * `artwork_url` is never overwritten with a false Discogs match (the
 * Natanya-record complaint this epic exists to fix).
 *
 * No `caller` label is passed. `library-artwork-url-backfill` is not yet
 * registered in `shared/lml-client/src/policy.ts`'s `ALL_LML_CALLERS`
 * (BS#1826) — an absent/unregistered caller is `policyForCaller`'s
 * documented safe no-op, so this call keeps the client's 30s `TIMEOUT_MS`
 * default, matching this job's pre-migration behavior. Registering a
 * caller label (and picking up class-5 batch/backfill budgets) is a
 * separate follow-up if this job's call volume ever needs it.
 */

import { lookupMetadata as sharedLookupMetadata, type GatedLookupResponse } from '@wxyc/lml-client';

export const lookupMetadata = (
  artist: string,
  album?: string,
  opts?: { discogsUnavailable?: boolean }
): Promise<GatedLookupResponse> => sharedLookupMetadata(artist, album, undefined, opts);
