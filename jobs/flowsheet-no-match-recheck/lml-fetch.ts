/**
 * LML lookup helper for jobs/flowsheet-no-match-recheck (BS#2176).
 *
 * Delegates to `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint) via the same `(artist, album, track)`
 * shape `jobs/flowsheet-metadata-backfill` uses — this job re-asks the
 * identical question the live worker originally asked, just later.
 * `decodeHtmlEntities` runs the row's text through HTML-entity decoding
 * first, same as `rotation-release-id-backfill`'s donor.
 *
 * `extractTrustedArtwork` gates every match through the track-context trust
 * predicate (`isTrustedLmlTrackContextMatch`, BS#1359, refined BS#2217)
 * before treating a response as resolvable — the exact chokepoint
 * `apps/enrichment-worker/enrich.ts#extractArtwork` uses, passing this
 * job's own `candidate.album_title` as the requested-album correspondence
 * check (BS#2217). A same-artist substitution (`fallback`/`alternative`)
 * always carries a real `library_item.id` and is rejected regardless; a
 * validated row-less resolution of the exact requested album
 * (`library_item.id === 0`, title matching `candidate.album_title`) is now
 * trusted even when `search_type` is `alternative` — that shape is the
 * primary reason this recheck job exists to re-ask frozen
 * `enriched_no_match` rows in the first place. `song_as_artist` stays
 * rejected outright regardless of id/title. This closes one of the three
 * sibling un-gated `extractArtwork`-shaped paths BS#1959 tracks, by making
 * sure this NEW path was gated from day one.
 *
 * `no_match` vs `trust_rejected` (BS#1516): a `no_match` means LML found no
 * candidate at all (or a trusted search_type with no artwork among its
 * results — the BS#961 compilation edge case); `trust_rejected` means LML
 * found a candidate but its `search_type` isn't trustworthy for a
 * track-context write.
 *
 * A cascade-timeout body (`timeout: true`) and a degraded response with no
 * usable answer are both treated as TRANSIENT — thrown so the caller leaves
 * the row's retry marker untouched. "No usable answer" covers a
 * breaker-open/shed `outcome` (BS#1995 Arm 3), `degraded_reason:
 * 'upstream_unavailable'`, and `degraded_reason: 'deadline_exceeded'`
 * (BS#2179 review HIGH 2 / BS#1977) — the budget-cutoff shed shape
 * `shared/lml-client/src/policy.ts`'s module docstring documents
 * (`degraded: true, degraded_reason: 'deadline_exceeded', artwork: null`).
 * This job exists to fix rows wrongly frozen at a permanent no-match;
 * writing a fresh false no-match from an unanswered LML call would be
 * self-defeating — the exact defect BS#1977 tracks for `enrichment-worker`,
 * reproduced here for a new caller and fixed at the same chokepoint
 * (`isUnansweredDegraded` below) rather than left to regress.
 *
 * `cache_only` is the third documented `degraded_reason`
 * (`tests/unit/shared/lml-client/degraded-discriminator.test.ts`) and is
 * deliberately NOT included: it is a genuine (if degraded-confidence)
 * answer LML served from cache, not an unanswered call, so a `cache_only`
 * response with no artwork stays a definitive `no_match`.
 *
 * BUDGET HEADER (BS#2218): every call sends `budgetMs: null` (BS#1914's
 * suppression lever) — no `X-Caller-Budget-Ms` header reaches LML at all,
 * unconditionally, no feature flag. This corrects BS#2179 review HIGH 3,
 * which concluded this job should keep the class-5 default (header sent
 * unconditionally) on the reasoning that the "4s cutoff is wrong" finding
 * was scoped to `enrichment-worker`'s live CDC lane, not batch drains
 * generally. That reasoning doesn't hold for this drain specifically: unlike
 * a generic backfill, this job's candidate cohort is DEFINED by having
 * already failed a live lookup once (`metadata_status = 'enriched_no_match'`),
 * so it is enriched for exactly the cold non-library releases that need
 * LML's full cascade — measured 4-20s on 2026-08-04, the same population
 * BS#1978 exists to serve. Prod measurement on 2026-08-18 confirmed the
 * consequence: the header's mere presence arms LML's ~4s empty-state cutoff
 * (`shared/lml-client/src/policy.ts`'s "CORRECTED MODEL"), so a `no_match`
 * row needing genuine cold resolution came back `deadline_exceeded` so
 * reliably that `isUnansweredDegraded` above kept re-queuing the same head
 * of the candidate set run after run — 64 rows drained from a 137,340-row
 * cohort in five runs, decaying toward zero. Unlike BS#1978's `'live'` lane,
 * there is no `'sweep'` lane sharing this call site that suppression must be
 * scoped away from — every candidate this job looks up is exactly the
 * population that needs the full cascade — so the lever applies
 * unconditionally, with no env-var gate. See BS#2218 for the measurement and
 * the query-ordering half of the same fix (`query.ts`).
 */

import {
  lookupMetadata as sharedLookupMetadata,
  isTrustedLmlTrackContextMatch,
  shedReasonOf,
  type DiscogsMatchResult,
  type GatedLookupResponse,
  type LookupResponse,
} from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';
import type { Candidate, LookupOutcome } from './orchestrate.js';

// Tubafrenzy paste data can land `flowsheet.artist_name` / `album_title` /
// `track_title` as HTML-escaped strings (e.g. "Rome&#769;o Poirier"). LML's
// NFKD diacritic strip runs over the raw string, so an entity-encoded
// combining mark never reaches that pass and the row stays a no-match.
// Decode here so the LML hop sees the same text a reader would — ported
// verbatim from `jobs/rotation-release-id-backfill/lml-fetch.ts`'s donor
// (BS#2179 review LOW finding: the donor has this, this job didn't).
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

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-fetch: ${name}=${raw} is invalid (must be positive number); using fallback ${fallback}`);
  return fallback;
};

// A client-side socket-abort safety net (35_000ms mirrors
// flowsheet-metadata-backfill's `BACKFILL_LML_PER_CALL_TIMEOUT_MS` default),
// NOT a lever that extends how long LML itself will search a cold release.
// BS#2218: `lookupNoMatchRecheck` now sends `budgetMs: null` unconditionally
// (see the module doc comment above), so `X-Caller-Budget-Ms` never reaches
// LML from this caller — the ~4s empty-state cascade cutoff that header arms
// (`shared/lml-client/src/policy.ts`'s "CORRECTED MODEL") does not apply
// here. A cold, hard-to-resolve release instead runs LML's full headerless
// cascade, bounded by LML's own `LML_SEARCH_HARD_TIMEOUT_MS` (25000ms
// default). This constant stays a safety margin ABOVE that hard cap — 35s —
// so it only fires on a genuinely wedged/hung connection, never as LML's
// normal (if slow) answer path. `isUnansweredDegraded` below still exists
// for the shapes that remain transient even headerless (a breaker-open/shed
// response, or a socket-level `timeout: true`) — see its own doc comment.
const TIMEOUT_MS = envInt('FLOWSHEET_NO_MATCH_RECHECK_LML_PER_CALL_TIMEOUT_MS', 35_000);

export const extractTrustedArtwork = (
  response: LookupResponse,
  requestedAlbum?: string | null
): DiscogsMatchResult | null => {
  if (!isTrustedLmlTrackContextMatch(response, requestedAlbum)) return null;
  // Walk `results` in order rather than reading only `results[0].artwork` —
  // an accepted `compilation` response can pair each `library_item` with
  // its own independently-resolved artwork, so the first entry's `artwork`
  // may be null while a later entry carries it (BS#961).
  for (const result of response.results ?? []) {
    if (result.artwork) return result.artwork;
  }
  return null;
};

type DegradedReason = NonNullable<LookupResponse['degraded_reason']>;

/**
 * Whether a given `degraded_reason` means "LML never produced a usable
 * verdict" (BS#2179 review HIGH 2 / BS#1977) as opposed to a genuine,
 * if degraded-confidence, answer. `satisfies Record<DegradedReason,
 * boolean>` makes this exhaustive at compile time: a `degraded_reason`
 * added to `@wxyc/shared`'s `LookupResponse` DTO fails typecheck here
 * until it is explicitly classified, so a future reason can't silently
 * fall through `isUnansweredDegraded` into a definitive `no_match` the way
 * `deadline_exceeded` did before this fix.
 */
const UNANSWERED_DEGRADED_REASON = {
  upstream_unavailable: true,
  deadline_exceeded: true,
  // A genuine (if degraded-confidence) answer served from cache, not an
  // unanswered call — see the module doc comment above.
  cache_only: false,
} satisfies Record<DegradedReason, boolean>;

const isUnansweredDegraded = (response: LookupResponse, artwork: DiscogsMatchResult | null): boolean => {
  const reason = response.degraded_reason;
  const isUnanswered =
    (reason !== undefined && UNANSWERED_DEGRADED_REASON[reason]) ||
    shedReasonOf(response as GatedLookupResponse) !== undefined;
  return isUnanswered && artwork === null;
};

export const lookupNoMatchRecheck = async (candidate: Candidate): Promise<LookupOutcome> => {
  const response = await sharedLookupMetadata(
    decodeHtmlEntities(candidate.artist_name),
    candidate.album_title !== null ? decodeHtmlEntities(candidate.album_title) : undefined,
    candidate.track_title !== null ? decodeHtmlEntities(candidate.track_title) : undefined,
    {
      limiter: defaultLmlLimiter,
      timeoutMs: TIMEOUT_MS,
      caller: 'flowsheet-no-match-recheck',
      discogsUnavailable: candidate.discogs_unavailable,
      // BS#2218: unconditional BS#1914 suppression — see the module doc
      // comment's "BUDGET HEADER" paragraph for why this drain, unlike a
      // generic class-5 backfill, needs LML's full cascade on every call.
      budgetMs: null,
    }
  );

  if (response.timeout) {
    throw new Error('LML lookup returned a timeout body; treating as transient so the row stays retryable');
  }

  const artwork = extractTrustedArtwork(response, candidate.album_title);

  if (isUnansweredDegraded(response, artwork)) {
    throw new Error(
      'LML lookup was degraded with no usable answer (breaker-open / shed); treating as transient so the row stays retryable'
    );
  }

  if (artwork) return { kind: 'resolved', artwork };

  if (
    response.search_type === 'direct' ||
    response.search_type === 'compilation' ||
    response.search_type === undefined
  ) {
    // A trusted search_type with no artwork in any result (BS#961 edge
    // case) is a genuine no-match, same as an absent search_type.
    return { kind: 'no_match' };
  }
  if (response.search_type === 'none') {
    return { kind: 'no_match' };
  }
  // fallback | alternative | song_as_artist: LML found a candidate but it's
  // a same-artist substitution, not track-confirmed (BS#1516).
  return { kind: 'trust_rejected', searchType: response.search_type };
};
