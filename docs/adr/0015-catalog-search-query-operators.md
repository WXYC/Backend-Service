# 0015 — Catalog free-text search retires the tsquery operator surface

`websearch_to_tsquery` gave the catalog tsvector tier three operators nobody chose: a leading `-` before a token means exclusion, a bare `or` between terms means disjunction, and a `"quoted phrase"` means a tsquery phrase match. They arrived free with the parser when the tier was written. They are not wholly undocumented: [`docs/catalog-search/README.md`](../catalog-search/README.md) records two of the three, but only as a reason the parser was chosen — it is "forgiving — it understands quoted phrases, `OR`, leading/trailing junk — and never raises on user input". That is a note about parser tolerance, not a contract anyone specified. No test pins any of the three. And dj-site does not merely leave them undocumented — it **advertises them**: the classic catalog search box renders a "Search tips" modal (`dj-site` `src/components/experiences/classic/catalog/SearchForm.tsx`) telling the DJ that `"double quotes signify an exact phrase"`, that `AND`/`OR`/`NOT` "can be used", and that `*` does wildcard matching. Measured on PG 18.6, exactly two of those five tips are true today — quoted phrases (`'cat' <-> 'power'`) and `OR` (`'cat' | 'power'`) — and they are two of the three operators this ADR retires. The other three are already false: `AND` lexes to `'a' & 'and' & 'b'`, `NOT` to `'rolling' & 'not' & 'stones'`, and `elect*` to plain `'elect'`. (That README sentence and this modal both describe the parser this ADR retires; the README belongs to WXYC/Backend-Service#670, the modal needs its own dj-site change, tracked as WXYC/dj-site#1662.)

That gap — no specified contract, no test, and a UI describing behaviour nobody had committed to — stopped being free the moment `websearch_to_tsquery` itself stopped being the query builder. WXYC/Backend-Service#670 replaces the tsvector tier's query construction with a last-token prefix builder, and a hand-built builder has to decide what a leading `-` means — deliberately here, or implicitly in whatever the builder happens to do. WXYC/Backend-Service#2709 is what implicit looks like: it inverted the operator rather than merely dropping it. Measured against `websearch_to_tsquery` on PG 18:

```
websearch_to_tsquery('simple', '-autechre stereolab')  ->  !'autechre' & 'stereolab'
```

A leading `-` excludes today. Under the #2709 builder, `stereolab -transient` went from `'stereolab' & !'transient'` (excluded) to `'stereolab':* & 'transient':*` (required) — the same input flipped from "must not contain" to "must contain." Bare `or` and quoted-phrase adjacency were lost in the same PR, but "read as literal text" is the wrong account of why. None of the three was in the builder's metacharacter class, so each survived the sanitizer into a quoted lexeme — and there `to_tsquery` re-lexes the quoted token and **discards `-` and `"` as blanks**. That is why the measured output above is `'transient':*` and not `'-transient':*`: the character is dropped, not preserved, and dropping a negation is exactly what leaves a live required term behind. Only the word `or` is genuinely read as literal text, becoming an ordinary AND'd token.

There is a second, independent reason to settle the quoted case specifically. A quoted term on the sibling `/library/query` surface means **whole-value** equality against the field, not a tsquery phrase — a contract specified in WXYC/Backend-Service#2398 and made case-insensitive by PR #2700. (WXYC/Backend-Service#2702 is a separate alias-UNION widening bug on the same endpoint; its own body says the whole-value behaviour "shipped and is not in question here", so it is not the origin of this contract.) A DJ who quotes `"cat power"` today gets a tsquery phrase match on `GET /library` and a whole-value match on `GET /library/query` — two meanings for the same syntax on two catalog surfaces, which is worse than the syntax not being supported on either.

## Decision

The catalog free-text surface (`GET /library`, `searchLibraryByTsvector` in [`apps/backend/services/library.service.ts`](../../apps/backend/services/library.service.ts)) retires all three operators. Two of them **were** advertised to DJs, in a modal that is already three-fifths wrong, so this is a deliberate removal of working behaviour rather than the tidying-away of something nobody knew about. It is worth doing anyway: the operators were never specified as a contract, no test pins them, a hand-built builder has to decide their fate regardless, and leaving that decision implicit is what produced the #2709 inversion. What the removal buys is a contract that is true; what it costs is two tips that must come out of dj-site's modal, tracked as WXYC/dj-site#1662. That ticket is the other half of this decision: until it lands, the modal describes behaviour the surface no longer has. The three decisions:

<!-- @rule id=catalog-tsquery-no-exclusion enforced-by=tests/integration/library.search-prefix-tsvector.spec.js added=2026-09-28 incidents=#2709 -->

- **A leading `-` is not exclusion.** A token that starts with `-` is treated as an ordinary search token, not a negation.

<!-- @rule id=catalog-tsquery-no-or enforced-by=tests/integration/library.search-prefix-tsvector.spec.js added=2026-09-28 incidents=#2709 -->

- **A bare `or` is not disjunction.** The word `or` between terms is treated as an ordinary AND'd token like any other, not a disjunction operator.

<!-- @rule id=catalog-tsquery-no-phrase enforced-by=tests/integration/library.search-prefix-tsvector.spec.js added=2026-09-28 incidents=#2709 -->

- **A `"quoted"` term is not a tsquery phrase.** Quote characters carry no query-building meaning on this surface. This removes the _tsquery-phrase_ form of the divergence from `/library/query`, not the divergence itself: `"cat power"` remains a whole-value match there and two AND'd tokens here, so the two surfaces still do not agree. What they no longer do is build _conflicting tsquery-shaped_ meanings for the same syntax. Whether `/library/query`'s whole-value behaviour should extend to `GET /library` is a separate, unmade decision.

**Scope.** This ADR governs the catalog free-text surface only. The flowsheet surface (`GET /flowsheet/search`) is **not** a mirror of it, and it would be wrong to assume the same three operators are in play there. That endpoint runs every `q` through `parseSearchQuery` before any SQL is built ([`apps/backend/services/search.service.ts`](../../apps/backend/services/search.service.ts)), so a quoted term becomes `exact: true` and routes to a whole-value `ilikeEscaped(..., 'exact')` — already `/library/query`'s contract, never reaching `websearch_to_tsquery` — and a bare `or` is tokenized as its own condition rather than handed to the parser inside a multi-term string. Only the leading `-` transfers — and not even cleanly. `shouldUseTsvector` routes any `all`-field token shorter than three characters to the trigram ILIKE branch, so `-a` is `!'a'` (an exclusion) on `GET /library` but a positive `ILIKE '%-a%'` on `GET /flowsheet/search` — opposite verdicts for one input, measured. That divergence is tracked as WXYC/Backend-Service#2712.

## The mechanic: quoting already retires it — do not strip, and do not sanitize

Retiring `-` needs **no new code**, and both obvious implementations are wrong. What actually kills the operator is the builder quoting every token: `to_tsquery` then never sees a bare `-` in operator position, and when it re-lexes the quoted token it discards a leading `-` as a blank (`ts_debug('simple','-transient')` → `blank '-'` + `asciiword transient`). That is the same discard described above, and it is why #2709 produced a _required_ term instead of a preserved `!`. The operator is dead by construction.

**Do not add `-` to the sanitizer's metacharacter class.** The metacharacter class is what the sanitizer uses to _split_ input into tokens — a character in that class is replaced with a space, so it becomes a token separator rather than being deleted in place. No such sanitizer exists on `main` today: the tier still calls `websearch_to_tsquery` directly, and the builder is introduced by WXYC/Backend-Service#670. In that builder the class is `&`, `|`, `!`, `(`, `)`, `<`, `>`, `:`, `*` and `\` — ten characters, and note that `"` is **not** among them, which is exactly why #2709 lost quoted-phrase adjacency rather than raising on it. **This ADR requires #670 to add `"` to that class**, which is a new obligation rather than a description of existing code; the reason is in the Consequences — the backslash included because a trailing `\` inside a quoted lexeme escapes its own closing quote and raises `42601` — so none of them can reach `to_tsquery` as a live operator. Adding `-` there would split on every hyphen, including interior ones. Interior hyphens are lexeme content, not punctuation to strip: `Chuquimamani-Condori` lexes under the `simple` config to the compound plus its two parts, which is exactly the shape migration `0178` (WXYC/Backend-Service#2714) bought a position gap in `library.search_doc` to protect — a hyphenated token produces a within-field adjacency chain that has to keep matching. Splitting on every `-` globally would destroy that compound before it ever reached the tsvector predicate, breaking the name the position-gap work exists to keep matching.

**Do not strip a leading `-` either.** It reads like the careful thing to do and it is measurably worse than doing nothing. For every token whose second character is a letter the strip is a pure no-op, because the lexer has already discarded the `-`. Measured on PG 18.6:

```
to_tsquery('simple', $$'-transient':*$$)       ->  'transient':*          -- identical to 'transient':*
to_tsquery('simple', $$'--foo':*$$)            ->  'foo':*                -- identical to 'foo':*
to_tsquery('simple', $$'-zoviet-france':*$$)   ->  'zoviet-france':* <-> 'zoviet':* <-> 'france':*
```

The strip changes the emitted query in exactly one class — a `-` followed by a **digit**, which the `simple` parser lexes as a signed `int` that keeps its sign — and there it breaks matching that works today:

```
to_tsquery('simple', $$'-3d':*$$)  ->  '-3':* <-> 'd':*     matches to_tsvector('simple','Minus 5 -3d World')  -- true
to_tsquery('simple', $$'3d':*$$)   ->  '3d':*               same document                                      -- FALSE
```

So a strip does nothing in the case it was written for and silently drops results in the only case it touches. The builder should leave the token alone.

## Consequences

- `stereolab -transient` and `stereolab transient` now search identically: both are two AND'd search tokens. There is no way to exclude a term on this surface after this ADR, by design — reintroducing exclusion is a future decision, not an oversight, and would need its own ADR given the #2709 inversion history.
- `cat or power` is three AND'd tokens, not a disjunction. A DJ who types `or` expecting "either" gets a narrower, not broader, result set — same posture as any other stray word.

<!-- @rule id=catalog-tsquery-strip-doublequote enforced-by=tests/integration/library.search-prefix-tsvector.spec.js added=2026-09-28 incidents=#2709 -->

- `"cat power"` and `cat power` now search identically on `GET /library`. Quote characters are inert **because the sanitizer strips them**, not on their own: an unstripped interior `"` survives into the quoted lexeme and the lexer treats it as a separator, so `'cat"power':*` emits `'cat':* <-> 'power':*` — an adjacency, not an AND. Measured: `to_tsvector('simple','Cat Great Power')` matches `'cat':* & 'power':*` but **not** `'cat"power':*`. Stripping `"` is therefore part of this contract, not housekeeping. This says nothing about `/library/query`'s whole-value posture, which is untouched by this ADR.
- The builder in WXYC/Backend-Service#670 is written against this contract from the start rather than inventing one at implementation time — the failure mode this ADR exists to close.

<!-- @rule id=catalog-tsquery-never-strip-leading-hyphen enforced-by=tests/integration/library.search-prefix-tsvector.spec.js added=2026-09-28 incidents=#2709 -->

- This contract has no enforcement point until that builder lands, and its tests are where it must be pinned. The load-bearing test is the one that fails when an interior `-` is split — `Chuquimamani-Condori` must still match every prefix of itself. A test asserting that a leading `-` is _removed from the emitted string_ would be actively harmful: it would certify the signed-integer regression above. Assert on match behaviour, not on the emitted query text.
- The two removals need their own pins, since they are live advertised behaviour and nothing currently guards them: one asserting that `cat or power` does **not** return the union of `cat` and `power` — note it does not return the same rows as `cat power` either: `or` becomes an ordinary required token, so the query narrows to nothing on a catalog with no literal "or" (measured: `cat power` → 2 rows, `cat or power` → 0). Assert the absence of the union, not equality. And one asserting `"cat power"` returns the same rows as `cat power` (no phrase), which does hold exactly. Without these, the ADR repairs the "no specified contract" half of its own diagnosis and leaves the "no test" half exactly as it found it.
- `docs/catalog-search/README.md` gets a pointer to this ADR; the prose describing the builder itself belongs to #670, not here.
