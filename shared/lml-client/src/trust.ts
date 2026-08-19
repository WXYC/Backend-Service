/**
 * Shared LML `search_type` trust predicates (BS#1356, BS#2217).
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
 *     lives on the returned release — trusts `direct`/`compilation`
 *     outright, and otherwise gates on request<->result CORRESPONDENCE
 *     rather than reading `search_type` as a confidence signal. See
 *     `isTrustedLmlTrackContextMatch`, wired into the live CDC enrichment
 *     path at `apps/enrichment-worker/enrich.ts#extractArtwork` (BS#1359,
 *     refined BS#2217) and `jobs/flowsheet-no-match-recheck/lml-fetch.ts`.
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
 *
 * `results` is consulted only by `isTrustedLmlTrackContextMatch`'s
 * correspondence check (BS#2217) — `isTrustedLmlAlbumMatch` never reads it.
 * `library_item.id` is the load-bearing field there: LML mints
 * `id === 0` (a row-less result — no WXYC catalog row) exclusively from
 * `_make_rowless_item`, reached only via `_resolve_nonlibrary_release` /
 * `_select_rowless_artist_release`, both of which resolve strictly from the
 * REQUEST's own artist and song. A row-less item can therefore never be a
 * shelf album substituted in — that structural guarantee is what makes
 * `id === 0` trustworthy as a correspondence signal where `search_type`
 * alone is not. `library_item.title` is the secondary check, compared
 * against the caller's requested album. Every field here is optional, like
 * `search_type` above: a caller with no `results` at all, an empty
 * `results` array, or a `results[0]` missing `library_item` all fail closed
 * through the same `!== 0` / empty-string comparisons rather than a runtime
 * error.
 */
export type LmlTrustGateInput = {
  search_type?: LookupResponse['search_type'];
  results?: {
    library_item?: {
      id?: number;
      title?: string | null;
    };
  }[];
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
 * Casefold + strip everything but letters/digits, collapsing to single
 * spaces. Deliberately NOT `@wxyc/database`'s `normalizeAlbumTitle`:
 * `@wxyc/lml-client` depends only on `@sentry/node` and `@wxyc/shared`, and
 * that normalizer carries a dedup-key stability contract tied to a live
 * cron (BS#2217 — considered and rejected). This is a local, throwaway
 * comparison key with no stability contract of its own; its only job is
 * absorbing casing/punctuation noise between a DJ's flowsheet entry and
 * Discogs's title string (e.g. "Caf&eacute; & Bar" vs "cafe and bar" after
 * upstream decoding), not edition-suffix stripping or dedup-key parity.
 */
const looseTitleKey = (s: string | null | undefined): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * True iff `response` is a track-context-trustworthy match for
 * `requestedAlbum`.
 *
 * `search_type` is provenance, not a confidence signal (BS#2217): LML
 * derives it purely from which search strategy ran last
 * (`core/search.py`'s `_search_type_string`, docstring "Derive the search
 * type string for telemetry from state"). A validated row-less resolution
 * of the exact requested album and a genuine same-artist substitution can
 * both come back `search_type: "alternative"` — the string alone can't
 * distinguish them, so this predicate doesn't ask it to.
 *
 * What it asks instead is request<->result CORRESPONDENCE:
 *   - `direct` / `compilation` are trusted outright — LML already confirmed
 *     the typed pair, or a V/A compilation genuinely carrying the played
 *     track (a different album by design, not a substitution).
 *   - `song_as_artist` is rejected outright, even with a row-less id and a
 *     title that happens to match: the played TITLE was matched as an
 *     artist name in that lane, so any title correspondence here is
 *     coincidence, not evidence the returned release is the one the DJ
 *     played.
 *   - Everything else (including `alternative`, `fallback`, `none`, and an
 *     absent `search_type`) is trusted only when `results[0].library_item.id
 *     === 0` (row-less — see `LmlTrustGateInput`'s doc comment for why that
 *     is structurally impossible for a shelf substitution) AND the returned
 *     title matches `requestedAlbum` after casefolding
 *     (`looseTitleKey`). Wrong-artist and same-artist substitutions
 *     (`Vantaa`, `Animaru / Kabutomushi`) always carry a real library id and
 *     are rejected by the `id === 0` check alone, before the title is even
 *     compared.
 *
 * An absent/null `requestedAlbum` leaves the carve-out inactive:
 * `looseTitleKey(undefined)` is `''`, and the comparison requires a
 * non-empty match, so the result is identical to the pre-BS#2217 behavior.
 * This is deliberate for the two Sentry-telemetry callers
 * (`isEmptyOutcome`/`classifyEmptyCause` in
 * `apps/enrichment-worker/empty-outcome.ts`) that have no request context to
 * supply — they fail closed rather than inventing one.
 *
 * The comparison is deliberately forgiving (casefold + strip punctuation,
 * nothing more) and deliberately narrow (gated behind `id === 0`): the
 * error asymmetry runs the opposite way from the usual trust-gate instinct
 * here. Too strict silently re-creates the BS#2217 defect (a validated
 * row-less match wrongly discarded) against a terminal `enriched_no_match`
 * write path that nothing revisits; too loose is bounded to
 * request-derived, row-less releases and can never resurrect a shelf
 * substitution. See the BS#2217 ticket for the prod replay that measured
 * this split.
 *
 * | search_type      | album match (`isTrustedLmlAlbumMatch`) | track-context match (this fn) | why |
 * |------------------|:---------------------------------------:|:------------------------------:|-----|
 * | direct           | trusted                                  | trusted                         | typed pair confirmed |
 * | compilation      | rejected                                 | trusted                         | V/A comp track-confirmed; different album by design, not a substitution |
 * | alternative      | rejected                                 | correspondence-gated            | provenance-only label (last-strategy telemetry); trusted iff `library_item.id === 0` (row-less, request-derived) AND the title matches `requestedAlbum` |
 * | fallback         | rejected                                 | correspondence-gated            | same telemetry caveat as `alternative` — no case in prod has hit this shape row-less, but nothing about `search_type` rules it out, so it is not special-cased away from the general check |
 * | song_as_artist   | rejected                                 | rejected                        | explicit lane exclusion — the song TITLE drove the match as an artist name, so a matching title here is coincidence, not track correspondence |
 * | none / absent    | rejected                                 | correspondence-gated (in practice rejected — `results` is empty for this type) | no trust signal beyond whatever `results` independently carries |
 */
export function isTrustedLmlTrackContextMatch(
  response: LmlTrustGateInput,
  requestedAlbum?: string | null
): boolean {
  const st = response.search_type;
  if (st === 'direct' || st === 'compilation') return true;
  if (st === 'song_as_artist') return false;
  const top = response.results?.[0];
  if (top?.library_item?.id !== 0) return false;
  const a = looseTitleKey(top.library_item?.title);
  return a !== '' && a === looseTitleKey(requestedAlbum);
}
