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
 * `library_item.id` is the load-bearing field there. LML has exactly two
 * producers of `id === 0` (a row-less result — no WXYC catalog row), and
 * the property that matters is shared by both: neither can return a shelf
 * album, because neither reads the shelf.
 *
 *   1. `_make_rowless_item`, the chokepoint for the four
 *      `LML_RESOLVE_NONLIBRARY_RELEASE`-gated producers, reached via
 *      `_resolve_nonlibrary_release` / `_select_rowless_artist_release`.
 *      Both resolve strictly from the REQUEST's own artist and song.
 *   2. `_library_miss_discogs_search` (LML#583), which builds its
 *      `LibraryItem(id=0)` directly rather than through that chokepoint —
 *      see `lookup/rowless.py`'s own note on why the LML#681 counter is
 *      deliberately scoped to producer 1 and not to all `id=0` items. It
 *      fires only when the library search MISSED, and searches Discogs with
 *      the typed artist and album under an 80/80 floor on both.
 *
 * So `id === 0` means "resolved from the request, not selected off the
 * shelf" — that structural guarantee is what makes it trustworthy as a
 * correspondence signal where `search_type` alone is not. Every substitution
 * measured in prod (`Vantaa`, `Animaru / Kabutomushi`) carried a real
 * library id.
 *
 * One caveat worth knowing when reading the title check below: producer 2
 * builds its item as `title=best.album or album`, falling back to the
 * caller's OWN typed album when the Discogs candidate carries no album
 * string. On that lane the title comparison can therefore be tautological,
 * and the real guarantee is the lane's own 80/80 artist+album floor rather
 * than the title equality. That is the reason `id === 0` — not the title —
 * is described as load-bearing here.
 *
 * `library_item.title` is the secondary check, compared
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
 * Fold diacritics, casefold, then strip everything but letters/digits,
 * collapsing to single spaces. Deliberately NOT `@wxyc/database`'s
 * `normalizeAlbumTitle`: `@wxyc/lml-client` depends only on `@sentry/node`
 * and `@wxyc/shared`, and that normalizer carries a dedup-key stability
 * contract tied to a live cron (BS#2217 — considered and rejected). The same
 * dependency-boundary argument rules out `@wxyc/database`'s `foldArtistName`,
 * whose NFD-fold-then-casefold step is the closer twin of the folding below:
 * it too lives across that edge, and it too carries a stability contract (its
 * output must stay byte-identical to the SQL side of `artistIdFromName`).
 * This is a local, throwaway comparison key with no stability contract of its own;
 * its only job is absorbing casing, punctuation, and accent noise between a
 * DJ's flowsheet entry and Discogs's title string, not edition-suffix
 * stripping or dedup-key parity.
 *
 * Worked examples of what each stage buys, from the shapes this actually
 * meets (the first two are the BS#2217 prod replay's two recovered rows):
 *   - `'Diptyque, Les Corps Glorieux'` vs `'Diptyque Les Corps Glorieux'`
 *     → punctuation stripping.
 *   - `'Minidisc'` vs `'MiniDisc'` → casefolding.
 *   - `'Café Bar'` vs `'Cafe Bar'` → diacritic folding. WXYC's catalog is
 *     full of accented titles (Nilüfer Yanya, Csillagrablók, Hermanos
 *     Gutiérrez) while flowsheet entries are hand-typed, so an unfolded
 *     comparison would reject that whole population (BS#2217 review).
 *     Folding happens via NFD + combining-mark removal *before*
 *     casefolding, so `é` and `E`-with-acute both reduce to `e`.
 */
const looseTitleKey = (s: string | null | undefined): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
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
 *     === 0` (row-less — see `LmlTrustGateInput`'s doc comment for the two
 *     producers and why neither can return a shelf substitution) AND the
 *     returned title matches `requestedAlbum` after casefolding, diacritic
 *     folding, and punctuation stripping
 *     (`looseTitleKey`). Wrong-artist and same-artist substitutions
 *     (`Vantaa`, `Animaru / Kabutomushi`) always carry a real library id and
 *     are rejected by the `id === 0` check alone, before the title is even
 *     compared.
 *
 * An absent/null `requestedAlbum` leaves the carve-out inactive:
 * `looseTitleKey(undefined)` is `''`, and the comparison requires a
 * non-empty match, so the result is identical to the pre-BS#2217 behavior.
 * That fail-closed default is for callers with genuinely no request context.
 * A caller that HAS one must pass it: the two Sentry-telemetry classifiers
 * (`isEmptyOutcome`/`classifyEmptyCause` in
 * `apps/enrichment-worker/empty-outcome.ts`) share `extractArtwork` with
 * `finalizeRow`, so asking them a different question than the write path was
 * asked makes the alert describe a write that didn't happen — see their doc
 * comments (BS#2217 review).
 *
 * The comparison is deliberately forgiving (casefold, fold diacritics, strip
 * punctuation, nothing more) and deliberately narrow (gated behind
 * `id === 0`): the
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
 *
 * ⚠ **If you are about to walk `response.results`, do not call this.** As of
 * BS#2217 this boolean has no production callers: both artwork extractors
 * moved to `lmlTrackContextTrust` + `lmlTrackContextVouchedResults`, because
 * a bare yes/no cannot tell them HOW MUCH of the response the trust covers,
 * and walking the whole array on the correspondence path is precisely the
 * `results[1]`-substitution hole that review closed. It is kept because it
 * is the name BS#1356/BS#1359 established across the docs, and because a
 * caller that genuinely only needs the yes/no (a metric, a log line, an
 * assertion) is well served by it. A caller that reads a PAYLOAD out of the
 * response is not — use the verdict pair.
 */
export function isTrustedLmlTrackContextMatch(response: LmlTrustGateInput, requestedAlbum?: string | null): boolean {
  return lmlTrackContextTrust(response, requestedAlbum) !== 'none';
}

/**
 * Why a response is track-context-trusted — and, critically, HOW MUCH of it
 * that trust covers (BS#2217 review).
 *
 *   - `'search_type'` — `direct`/`compilation`. LML vouched for the whole
 *     response, so a caller may read artwork from ANY entry in `results`.
 *     That matters: an accepted `compilation` response pairs each
 *     `library_item` with its own independently-resolved artwork, so
 *     `results[0].artwork` can be null while a later entry carries it
 *     (BS#961).
 *   - `'correspondence'` — the BS#2217 carve-out. The evidence is
 *     `results[0]`'s own row-less id and title, and it extends to NOTHING
 *     else in the array. A caller must read artwork from `results[0]` only.
 *     Walking past it would let a same-artist substitution sitting at
 *     `results[1]` (real `library_item.id`, its own artwork) donate its
 *     cover to a row the gate accepted solely on `results[0]`'s evidence —
 *     precisely the Yenbett/Vantaa class the gate exists to block, smuggled
 *     in through the index.
 *   - `'none'` — not trusted; no entry may be read.
 *
 * `isTrustedLmlTrackContextMatch` is the boolean projection of this, kept
 * for the callers that only need the yes/no (the two Sentry-telemetry
 * classifiers, and the album-context gates that never walk `results`).
 */
export type LmlTrackContextTrust = 'none' | 'search_type' | 'correspondence';

/**
 * The subset of `results` a `trust` verdict actually vouches for — the
 * executable form of the contract `LmlTrustGateInput`'s doc comment states in
 * prose (BS#2217 review).
 *
 * Every caller that walks `results` looking for a payload (artwork today)
 * must iterate THIS, not `response.results`. The rule is one line, but it is
 * the line that keeps the correspondence carve-out honest: the carve-out
 * accepts a response on `results[0]`'s row-less id and title alone, so a
 * same-artist substitution parked at `results[1]` — real `library_item.id`,
 * its own artwork — must not be able to donate its cover to that acceptance.
 * Keeping the rule here rather than hand-rolled at each walk means a future
 * caller cannot reintroduce the Yenbett/Vantaa class by copying the loop and
 * forgetting the guard.
 *
 * Generic in the element type so each caller keeps its own richer result
 * shape (the artwork-bearing `LookupResponse['results']`) without a cast;
 * this function only ever slices, never inspects.
 */
export function lmlTrackContextVouchedResults<T>(
  trust: LmlTrackContextTrust,
  results: readonly T[] | null | undefined
): readonly T[] {
  if (trust === 'none') return [];
  const all = results ?? [];
  return trust === 'correspondence' ? all.slice(0, 1) : all;
}

export function lmlTrackContextTrust(
  response: LmlTrustGateInput,
  requestedAlbum?: string | null
): LmlTrackContextTrust {
  const st = response.search_type;
  if (st === 'direct' || st === 'compilation') return 'search_type';
  if (st === 'song_as_artist') return 'none';
  const top = response.results?.[0];
  if (top?.library_item?.id !== 0) return 'none';
  const returned = looseTitleKey(top.library_item?.title);
  return returned !== '' && returned === looseTitleKey(requestedAlbum) ? 'correspondence' : 'none';
}
