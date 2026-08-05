/**
 * Thin LML shim for the BS#2000 V/A remediation.
 *
 * Wraps `@wxyc/lml-client.lookupMetadata` with `extended: true` so the
 * re-verify walks the same `/api/v1/lookup` path the enrichment worker used
 * when it persisted the URL being re-adjudicated.
 *
 * The return type is widened to `GatedLookupResponse` on purpose. The
 * BS#1631 donor's shim declares `LookupResponse`, which compiles fine
 * (`GatedLookupResponse extends LookupResponse`) but ERASES the `outcome`
 * discriminator at the shim boundary — and `outcome` is exactly what
 * `verdict.ts` needs to tell a shed or a BS#1293 skip apart from a genuine
 * no-match. Narrowing here would silently collapse the three-way verdict into
 * a two-way one, which is the failure mode this job is built to avoid.
 */

import { lookupMetadata as sharedLookupMetadata, type GatedLookupResponse } from '@wxyc/lml-client';
import { envInt } from './env.js';
import { defaultLmlLimiter } from './lml-limiter.js';

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 35_000, 'lml-fetch');

export const lookupMetadata = async (artist: string, album?: string, track?: string): Promise<GatedLookupResponse> =>
  sharedLookupMetadata(artist, album, track, {
    extended: true,
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
    caller: 'va-apple-music-url-remediation',
  });
