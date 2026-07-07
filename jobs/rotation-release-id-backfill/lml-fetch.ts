/**
 * Backfill-side LML lookup helper for jobs/rotation-release-id-backfill
 * (BS#1029).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint introduced in BS#887) and injects:
 *   - the backfill's own `defaultLmlLimiter` so this surface gets its
 *     stricter BACKFILL_LML_* rate ceiling instead of the runtime path's
 *     LML_CLIENT_* defaults (BS#995 / BS#994), and
 *   - a tighter per-call abort budget (`BACKFILL_LML_PER_CALL_TIMEOUT_MS`,
 *     default 8000 ms) so cold-tail rows that LML can't resolve quickly
 *     don't hold one of LML's serialized Discogs fan-out slots for the
 *     runtime path's 30 s (BS#994 / BS#1017).
 *
 * Returns a discriminated `LookupOutcome`: `resolved` (a `direct`-match
 * Discogs release id), `no_match` (LML found no candidate id), or
 * `trust_rejected` (a candidate id arrived on a non-`direct` — or absent —
 * `search_type` and must not be persisted; BS#1516). Mirrors the runtime
 * tier-3 path's extraction plus its BS#1351/BS#1355 trust gate so the SAME
 * entity is persisted whether the resolution happened at runtime or offline.
 */

import { lookupMetadata as sharedLookupMetadata } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';
import type { LookupOutcome } from './orchestrate.js';

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

const TIMEOUT_MS = envInt('BACKFILL_LML_PER_CALL_TIMEOUT_MS', 8000);

// Tubafrenzy paste data can land `rotation.artist_name` / `rotation.album_title`
// as HTML-escaped strings (e.g. "Rome&#769;o Poirier"). LML's NFKD diacritic
// strip runs over the raw string, so an entity-encoded combining mark never
// reaches that pass and the row stays NO_RESULT. Decode here so the LML hop
// sees the same text a reader would.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const HTML_ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

const decodeHtmlEntities = (input: string): string =>
  input.replace(HTML_ENTITY_RE, (match, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    const isHex = body[1] === 'x' || body[1] === 'X';
    const codepoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    // Reject surrogate-range too: String.fromCodePoint accepts lone
    // surrogates without throwing and would produce ill-formed UTF-16 that
    // breaks JSON.stringify on the LML hop.
    if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return match;
    return String.fromCodePoint(codepoint);
  });

export const lookupReleaseId = async (artist: string, album: string): Promise<LookupOutcome> => {
  const response = await sharedLookupMetadata(decodeHtmlEntities(artist), decodeHtmlEntities(album), undefined, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
  });
  const releaseId = response.results?.[0]?.artwork?.release_id ?? null;
  if (releaseId === null) return { kind: 'no_match' };
  // BS#1516: only a `direct` match may be persisted. Non-direct
  // `search_type` values are artist-fallback answers — `results[0]` is a
  // DIFFERENT album by the same artist (the Yenbett→Tzenni recurrence,
  // BS#1515), and a persisted wrong id is served by tier 1 forever; the
  // runtime BS#1351 gate never re-checks stored ids. Fail closed when
  // `search_type` is absent: no trust signal, no persist. Mirrors the
  // coordinator's `requireSearchType: 'direct'` (BS#1355), which this job
  // can't use because it imports `@wxyc/lml-client` directly.
  if (response.search_type !== 'direct') {
    return { kind: 'trust_rejected', searchType: response.search_type ?? 'absent' };
  }
  // `release_id: 0` (BS#1185 streaming-only sentinel) intentionally passes
  // through as `resolved` — the orchestrator owns sentinel counting (BS#1429).
  return { kind: 'resolved', releaseId };
};
