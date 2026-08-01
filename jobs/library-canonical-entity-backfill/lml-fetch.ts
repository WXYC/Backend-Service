/**
 * LML lookup fetcher for the library.canonical_entity_id backfill (B-1.2).
 *
 * BS#1910: migrated off a vendored `fetch()` straight to
 * `${baseUrl()}/api/v1/lookup` onto `@wxyc/lml-client.lookupMetadata` — the
 * shared HTTP + Sentry-instrumentation chokepoint every other backfill job
 * already uses (mirrors `jobs/library-artwork-url-backfill/lml-fetch.ts`).
 * The prior hand-rolled fetch could never carry a `caller` label, so it was
 * invisible to the BS#1826 caller-classification policy and to LML's
 * `X-Caller-Class` header (BS#1843) — exactly the D4 gap
 * library-metadata-lookup's `/lookup` location-union feature depends on BS
 * closing (`plans/location-union-transparent-results.md`): LML skips its
 * recall-index probe for callers it sees as low-priority
 * (`X-Caller-Class=5`), and this job's traffic was previously unclassified.
 * Registering `library-canonical-entity-backfill` as class 5 in
 * `shared/lml-client/src/policy.ts` closes that gap.
 *
 * This is a transport swap, not a behavior change:
 *   - `timeoutMs: 30000` is passed explicitly (rather than left to default
 *     to the class-5 policy's 29s) so this job's per-call abort budget
 *     stays byte-identical to its pre-migration value — this job
 *     deliberately runs a longer timeout than the interactive-path default
 *     because it processes long-tail rows that trigger Discogs/MusicBrainz
 *     fallback chains, and `orchestrate.ts`'s `THROTTLE_MS=100` sequential
 *     loop caps in-flight requests at one, so the longer per-call cap
 *     doesn't risk piling up on LML.
 *   - The bearer header (`LML_API_KEY`, when set) is applied identically by
 *     the shared client's chokepoint.
 *   - A thrown failure (timeout, non-2xx, network error) still surfaces as
 *     a plain `Error` (`LmlClientError extends Error`) that
 *     `orchestrate.ts`'s `processRow` catches and counts as `'error'`, so a
 *     bad row still rolls forward to the next sweep unchanged — only the
 *     thrown message text differs from the old vendored fetch's.
 *   - The shared client additionally runs the JSON response through
 *     `sanitizeLookupStreamingUrls` (BS#1710) before returning. This is a
 *     no-op for this job: `resolve.ts`'s `resolveCanonicalEntity` only reads
 *     `results[0].artwork.release_id` and `search_type`, never any
 *     streaming-URL field.
 */

import { lookupMetadata as sharedLookupMetadata } from '@wxyc/lml-client';
import type { LmlLookupResponse } from './lml-types.js';

export const lookupMetadata = (artist: string, album?: string): Promise<LmlLookupResponse> =>
  sharedLookupMetadata(artist, album, undefined, {
    caller: 'library-canonical-entity-backfill',
    timeoutMs: 30000,
  });
