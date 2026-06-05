# 0002 — `library_identity.entity_id` is the canonical cross-app artist identifier

The cross-app canonical artist identifier across Backend-Service, semantic-index, dj-site, the iOS DJ tool, request-o-matic, and future WXYC surfaces is `library_identity.entity_id` as composed by LML. For v1 the iOS DJ tool reaches us using BS `artists.id` and we serve it back unchanged; we are the abstraction seam — when the [`library_identity` substrate](../../shared/database/src/migrations/0075_library-identity-substrate.sql) is populated (depends on [#802](https://github.com/WXYC/Backend-Service/issues/802) and [LML project #25 cross-cache-identity](https://github.com/orgs/WXYC/projects/25)), we swap our internal identifier translation and downstream clients keep shipping unchanged.

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0001](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0001--library_identityentity_id-is-the-canonical-artist-identifier) and the repo-local [iOS ADR 0001](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/adr/0001-entity-id-canonical-artist-identifier.md).

## Consequences

- Our `/library/search` response shape needs an `artist_id: integer` field on `AlbumSearchResult` (currently `artist_name` only — see cross-repo doc coordination item C1, plus [`wxyc-shared/api.yaml`](https://github.com/WXYC/wxyc-shared/blob/main/api.yaml)). Nullable for legacy rows.
- Our `/graph/*` proxy routes (per ADR 0003 in this directory) own the identifier-translation seam. iOS-facing artist_id is what we accept; whatever semantic-index needs is what we translate to internally.
- A one-off diff script should verify BS `artists.id` ≡ semantic-index `id` for the corpus in scope before iOS ships Artist Deep Dive or Underplayed Gems. Both lineages descend from tubafrenzy but may have drifted.
- Homonym artists (e.g. "Beach" the Korean band vs "Beach" the German artist) remain ambiguous in our responses until the substrate is wired. Migrating to `entity_id` fixes this without iOS or dj-site code changes.
