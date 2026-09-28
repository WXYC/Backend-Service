# 0015 — Catalog free-text search retires the tsquery operator surface

`websearch_to_tsquery` gave the catalog tsvector tier three operators nobody chose: a leading `-` before a token means exclusion, a bare `or` between terms means disjunction, and a `"quoted phrase"` means a tsquery phrase match. They arrived free with the parser when the tier was written ([`docs/catalog-search/README.md`](../catalog-search/README.md)); no catalog surface documents them, no test pins them, and dj-site's search box gives the DJ no indication any of the three exist.

That silence stopped being free the moment `websearch_to_tsquery` itself stopped being the query builder. WXYC/Backend-Service#670 replaces the tsvector tier's query construction with a last-token prefix builder, and a hand-built builder has to decide what a leading `-` means — deliberately here, or implicitly in whatever the builder happens to do. WXYC/Backend-Service#2709 is what implicit looks like: it inverted the operator rather than merely dropping it. Measured against `websearch_to_tsquery` on PG 18:

```
websearch_to_tsquery('simple', '-autechre stereolab')  ->  !'autechre' & 'stereolab'
```

A leading `-` excludes today. Under the #2709 builder, `stereolab -transient` went from `'stereolab' & !'transient'` (excluded) to `'stereolab':* & 'transient':*` (required) — the same input flipped from "must not contain" to "must contain." Bare `or` and quoted-phrase adjacency were lost the same PR, by the same mechanism: none of the three characters was in the builder's metacharacter class, so each survived into a quoted lexeme and was read as literal text rather than as the operator it used to be.

There is a second, independent reason to settle the quoted case specifically. WXYC/Backend-Service#2702 established that a quoted term on the sibling `/library/query` surface means **whole-value** equality against the field, not a tsquery phrase. A DJ who quotes `"cat power"` today gets a tsquery phrase match on `GET /library` and a whole-value match on `GET /library/query` — two meanings for the same syntax on two catalog surfaces, which is worse than the syntax not being supported on either.

## Decision

The catalog free-text surface (`GET /library`, `searchLibraryByTsvector` in [`apps/backend/services/library.service.ts`](../../apps/backend/services/library.service.ts)) retires all three operators. None was ever advertised to DJs, so the loss is intentional and documented rather than accidental and silent:

- **A leading `-` is not exclusion.** A token that starts with `-` is treated as an ordinary search token, not a negation.
- **A bare `or` is not disjunction.** The word `or` between terms is treated as an ordinary AND'd token like any other, not a disjunction operator.
- **A `"quoted"` term is not a tsquery phrase.** Quote characters carry no query-building meaning on this surface. This also removes the divergence from `/library/query`'s whole-value quoted-term semantics — the two surfaces no longer disagree, because neither treats quoting as a tsquery-phrase instruction. (Whether `/library/query`'s whole-value behavior should extend to `GET /library` is a separate, unmade decision; this ADR only closes the gap that both surfaces silently building _conflicting_ tsquery-shaped meanings for the same syntax was worse than either.)

## The mechanic: strip, don't sanitize

Retiring `-` as an operator means the builder **strips a leading `-` from each token's leading position** before treating the remainder as a search token. It does **not** mean adding `-` to the sanitizer's metacharacter class.

Those are different operations with different blast radii. The metacharacter class is what the sanitizer uses to _split_ input into tokens — a character in that class becomes a token separator, the same treatment `&`, `|`, `!`, `(`, `)`, `<`, `>`, `:`, and `*` already get so they can't reach `to_tsquery` as live operators. Adding `-` there would split on every hyphen, including interior ones. Interior hyphens are lexeme content, not punctuation to strip: `Chuquimamani-Condori` lexes under the `simple` config to the compound plus its two parts, which is exactly the shape migration `0178` (WXYC/Backend-Service#2714) bought a position gap in `library.search_doc` to protect — a hyphenated token produces a within-field adjacency chain that has to keep matching. Splitting on every `-` globally would destroy that compound before it ever reached the tsvector predicate, breaking the name the position-gap work exists to keep matching.

So the leading-`-` strip is a per-token, position-anchored operation — remove `-` only when it is the first character of a token — applied before tokens are quoted and suffixed for the prefix builder, not a change to what counts as a separator. A token like `Chuquimamani-Condori` is untouched (no leading `-`); a token like `-transient` becomes `transient`.

## Consequences

- `stereolab -transient` and `stereolab transient` now search identically: both are two AND'd search tokens. There is no way to exclude a term on this surface after this ADR, by design — reintroducing exclusion is a future decision, not an oversight, and would need its own ADR given the #2709 inversion history.
- `cat or power` is three AND'd tokens, not a disjunction. A DJ who types `or` expecting "either" gets a narrower, not broader, result set — same posture as any other stray word.
- `"cat power"` and `cat power` now search identically on `GET /library`; quote characters are inert. This matches nothing said about `/library/query`'s whole-value posture, which is untouched by this ADR.
- The builder in WXYC/Backend-Service#670 is written against this contract from the start rather than inventing one at implementation time — the failure mode this ADR exists to close.
- `docs/catalog-search/README.md` gets a pointer to this ADR; the prose describing the builder itself belongs to #670, not here.
