# 0003 — We proxy semantic-index under `/graph/*`; clients never call semantic-index directly

We expose a new `/graph/*` route group that mirrors the [semantic-index public surface](https://github.com/WXYC/semantic-index/blob/main/semantic_index/api/__init__.py) (`/graph/artists/search`, `/graph/artists/{id}/neighbors`, `/graph/artists/{id}/explain/{target_id}`, …) and adds two BS-side concerns the semantic-index doesn't own: **(1) identifier translation** between our `artists.id` and whatever semantic-index needs (today: same value; future: `entity_id` resolution per ADR 0002), and **(2) composition** — `/graph/artists/{id}/deep-dive`, `/graph/artists/{id}/underplayed?for_dj={dj_id}`, etc. fan out internally to LML + semantic-index + our Postgres and return one structured payload so mobile clients pay one round trip instead of N+1.

The iOS DJ tool has one auth model (JWT against BS) and one base URL — adding a second base URL with no auth (semantic-index is public-by-default) would break that invariant. The proxy preserves the invariant and the composition is what makes the Picks list shippable. Without composition, the proxy is overhead; with it, it earns its keep.

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0002](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0002--backend-service-proxies-semantic-index-ios-never-calls-semantic-index-directly).

## Consequences

- We add a new runtime dependency on semantic-index reachability. `/graph/*` routes return 503 cleanly when semantic-index is down; other routes are unaffected.
- We gain response caching for semantic-index calls (queries are deterministic for given input). Pattern follows our existing [`proxy/`](../../apps/backend/src) controllers for LML.
- Composed endpoints are net-new resources we own; we get to shape them for the consumer (iOS picks list, dj-site equivalent) rather than passing through a third-party shape.
