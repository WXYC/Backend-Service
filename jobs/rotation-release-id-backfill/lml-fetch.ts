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
 * Returns the resolved Discogs release id (or null when LML found no
 * Discogs match). Mirrors the runtime tier-3 path's extraction at
 * `apps/backend/services/library.service.ts:492` so the SAME entity is
 * persisted whether the resolution happened at runtime or offline.
 */

import { lookupMetadata as sharedLookupMetadata } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

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
    if (body[0] === '#') {
      const codepoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codepoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });

export const lookupReleaseId = async (artist: string, album: string): Promise<number | null> => {
  const response = await sharedLookupMetadata(decodeHtmlEntities(artist), decodeHtmlEntities(album), undefined, {
    limiter: defaultLmlLimiter,
    timeoutMs: TIMEOUT_MS,
  });
  return response.results?.[0]?.artwork?.release_id ?? null;
};
