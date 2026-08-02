/**
 * Shared LML `search_type` trust predicates (BS#1356).
 *
 * LML's `search_type` discriminator tells a caller HOW a result was found:
 * `direct` confirms the literal (artist, album) pair typed by the caller
 * exists in Discogs as typed. Every other value (`fallback`, `alternative`,
 * `compilation`, `song_as_artist`, `none`) is a candidate LML offers when the
 * typed pair wasn't found outright — `results[0]` may name a DIFFERENT album
 * by the same artist (the Yenbett -> Tzenni recurrence, BS#1515 / BS#1516).
 * Whether that candidate is trustworthy enough to auto-persist depends on
 * WHAT is being persisted:
 *
 *   - An **album-context** write — a librarian typed this exact release
 *     (addAlbum, the rotation picker, canonical-entity linkage) — can only
 *     trust `direct`. See `isTrustedLmlAlbumMatch`.
 *   - A **track-context** write — a DJ played this track and LML confirms it
 *     lives on the returned release — can also trust `compilation`: a V/A
 *     comp genuinely carrying that track is a correct match, not a
 *     same-artist substitution. See `isTrustedLmlTrackContextMatch`,
 *     reserved for BS#1359 (PR 3 of this reconciliation) and not wired into
 *     any callsite yet.
 *
 * Both predicates fail closed on an absent/undefined `search_type`: no trust
 * signal means no auto-accept. Neither bundles payload extraction (e.g.
 * pulling `results[0].artwork.release_id`) — trust ("is this match
 * believable") stays orthogonal to extraction ("is there a usable id"),
 * because callers disagree on how to read a usable id out of an already-
 * trusted response (the rotation picker treats a `release_id: 0` sentinel as
 * "no Discogs id, but the inline tracklist is still valid"; the
 * `rotation-release-id-backfill` orchestrator counts that same sentinel
 * separately from a real id). Bundling extraction here couldn't serve both.
 * See the BS#1356 decision memo §3 for the full reasoning.
 *
 * `SEARCH_TYPE_CONFIDENCE` in `apps/backend/services/library.service.ts`
 * stays descriptive audit metadata (BS#1356 memo §4) — it is NOT a second
 * write gate. These two predicates are the only auto-accept authority; every
 * write-gate callsite (the coordinator's `applyTrustGate`, and the two
 * offline job gates in `jobs/rotation-release-id-backfill/lml-fetch.ts` and
 * `jobs/library-canonical-entity-backfill/resolve.ts`) delegates to
 * `isTrustedLmlAlbumMatch` rather than re-deriving the `direct` comparison.
 */
import type { LookupResponse } from '@wxyc/shared/dtos';

/**
 * Minimal response shape both predicates need. Deliberately narrower than
 * the full `LookupResponse` so a caller that maintains its own trimmed
 * response type — e.g. `jobs/library-canonical-entity-backfill`'s
 * `LmlLookupResponse`, which mirrors `LookupResponse` without importing
 * `@wxyc/shared` types directly — can pass its own object structurally, with
 * no cast. `search_type` is optional here even though the SSOT schema marks
 * it required-with-a-default: a defensively-typed absent case is exactly
 * what "fail closed" means, and strict equality against a literal handles
 * `undefined` for free.
 */
export type LmlTrustGateInput = {
  search_type?: LookupResponse['search_type'];
};

/**
 * True iff `response` is a `direct` search_type match — LML confirmed the
 * literal (artist, album) pair typed by the caller. Fails closed (`false`)
 * on any non-`direct` value, including an absent or `undefined`
 * `search_type`.
 *
 * Deliberately does NOT conjoin a `confidence >= threshold` check: today
 * confidence is *derived from* `search_type` (see `SEARCH_TYPE_CONFIDENCE`
 * in `library.service.ts`), so `direct` <=> the top band <=> passes — a
 * hard-coded conjunct here would imply an independent signal LML doesn't
 * emit yet. When LML ships per-result confidence (LML#158), add the floor
 * INSIDE this predicate, in this one place — not as a second conjunct
 * duplicated at each callsite.
 */
export function isTrustedLmlAlbumMatch(response: LmlTrustGateInput): boolean {
  return response.search_type === 'direct';
}

/**
 * True iff `response` is a `direct` OR `compilation` search_type match.
 * Reserved for BS#1359 (PR 3 of the trust-gate reconciliation) — a
 * DJ-played *track*, not a librarian-typed album, is the context here: LML
 * confirms the typed track appears on the returned release, and a V/A
 * compilation genuinely carrying that track is a correct match, not the
 * same-artist substitution `isTrustedLmlAlbumMatch` guards against.
 * `alternative` stays excluded even in track context — it's LML's
 * closest-match fallback when neither the artist nor the album was
 * confirmed, carrying no track-level confirmation at all.
 *
 * | search_type      | album match (`isTrustedLmlAlbumMatch`) | track-context match (this fn) | why |
 * |------------------|:---------------------------------------:|:------------------------------:|-----|
 * | direct           | trusted                                  | trusted                         | typed pair confirmed |
 * | compilation      | rejected                                 | trusted                          | V/A comp track-confirmed; different album by design, not a substitution |
 * | alternative      | rejected                                 | rejected                         | closest-match fallback, no track confirmation |
 * | fallback         | rejected                                 | rejected                         | artist-only fallback answer |
 * | song_as_artist   | rejected                                 | rejected                         | title matched as an artist name, not this track |
 * | none / absent    | rejected                                 | rejected                         | no result / no trust signal |
 *
 * Not wired into any callsite in this PR — BS#1359 lands the
 * `metadata.service.ts` migration (and the wider track-context job family)
 * on its own option-A approval.
 */
export function isTrustedLmlTrackContextMatch(response: LmlTrustGateInput): boolean {
  return response.search_type === 'direct' || response.search_type === 'compilation';
}
