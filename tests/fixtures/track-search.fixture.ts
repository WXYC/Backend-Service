/**
 * Track-search fixture constants (BS#825, catalog-track-search plan §3.2).
 *
 * Companion to the SQL inserts in `tests/fixtures/shape.sql` (Track 2 block)
 * and the song-driven mock-LML fixtures in
 * `dev_env/mock-api-server/src/fixtures/lml.json` (`songLookup` map). Exposes
 * the shared IDs / titles / query strings so the integration suite in
 * `tests/integration/library.spec.js` can reference the seeded rows by name
 * rather than by magic number.
 *
 * Three releases:
 *
 *   1. `CONFIELD` — Autechre/Confield, mapped to the LML mock's `vi scose
 *      poise` song-lookup response with `matched_via.source = "discogs_master"`.
 *   2. `DIRECT_RELEASE` — a synthetic release wired to
 *      `discogs:release:<id>` so its lookup carries
 *      `matched_via.source = "discogs_release"`.
 *   3. `CTA_COLLISION` — a release seeded into both `compilation_track_artist`
 *      (Track 1) and the LML mock's `songLookup` (Track 2) for the same
 *      query. The cascade short-circuits at Track 1 and never invokes Track
 *      2, but if it did, `searchLibraryByTrack`'s CTA-exclusion SELECT must
 *      drop this row.
 *
 * Query strings are intentionally multi-token nonce phrases ("Direct Release
 * Track e25b", "CTA Collision Track e25b") so they cannot satisfy the
 * primary tsvector or trigram path on any seeded library row's album_title /
 * artist_name. That forces the cascade past the primary search into the
 * Track-1/Track-2 fallbacks under test. `"vi scose poise"` is the
 * acceptance-criteria-mandated query (BS#825, plan §3.2 — verified against
 * prod for the real Confield row at `library.id=60359`).
 */

export interface TrackSearchRelease {
  /** Backend `library.id` for the seeded row. */
  readonly libraryId: number;
  /** Backend `library.legacy_release_id` — the bridge key the LML mock
   *  returns as `library_item.id`. */
  readonly legacyReleaseId: number;
  /** Backend `library.canonical_entity_id`. */
  readonly canonicalEntityId: string;
  /** Album title seeded into `library.album_title`. */
  readonly albumTitle: string;
  /** Artist name seeded into `library.artist_name`. */
  readonly artistName: string;
}

export const CONFIELD: TrackSearchRelease = {
  libraryId: 7100,
  legacyReleaseId: 65880,
  canonicalEntityId: 'discogs:master:1374',
  albumTitle: 'Confield',
  artistName: 'Autechre',
};

export const DIRECT_RELEASE: TrackSearchRelease = {
  libraryId: 7101,
  legacyReleaseId: 65881,
  canonicalEntityId: 'discogs:release:99887766',
  albumTitle: 'Synth Bayou Quarterly',
  artistName: 'Liminal Cartographer',
};

export const CTA_COLLISION: TrackSearchRelease = {
  libraryId: 7102,
  legacyReleaseId: 65882,
  canonicalEntityId: 'discogs:master:7777',
  albumTitle: 'Polychrome Aviary',
  artistName: 'Plebs Of The Dawnchorus',
};

/**
 * Queries that key into `dev_env/mock-api-server/src/fixtures/lml.json`'s
 * `songLookup` map. The lookup key is the lowercased query — the
 * integration test sends the casing below; the mock lowercases at match
 * time.
 *
 * Direct-release and CTA-collision queries are intentional nonce-token
 * phrases (random strings, no shared tokens with any seeded album_title or
 * artist_name) so the primary `searchLibrary` tsvector + trigram path
 * returns 0 hits and the cascade reaches Track 1 (CTA) / Track 2 (LML).
 */
export const QUERIES = {
  /** Confield track. Acceptance-criteria mandated. */
  CONFIELD_TRACK: 'vi scose poise',
  /** Nonce query — exercises `discogs_release` provenance. */
  DIRECT_RELEASE_TRACK: 'xqfp7k zelmpo b3nvh4',
  /** Nonce query — also seeded into compilation_track_artist for CTA_COLLISION.libraryId. */
  CTA_COLLISION_TRACK: 'wbtr2x cmprs 9azn5',
} as const;
