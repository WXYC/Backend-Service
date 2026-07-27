/**
 * Normalized `(artist, album)` → linked `library.id` resolver (BS#1829,
 * extracted from `apps/backend/services/album-metadata-lookup.service.ts` —
 * album-critic-reviews slice, ADR 0012 — parent epic #1718).
 *
 * Lives here (not in `apps/backend`) so a `jobs/` workspace can import it:
 * each job's Dockerfile copies only the job dir + `@wxyc/database`, and an
 * `apps/backend` import fails that build stage (see the header comment of
 * `jobs/artist-search-alias-consumer/compilation.ts` and
 * `jobs/flowsheet-artwork-repair/repair.ts`). The upcoming
 * `jobs/album-critic-reviews-etl/` (#1830) needs the SAME exact-match
 * semantics the serve path uses, or seeded rows drift from what
 * `GET /proxy/metadata/album` can actually find.
 *
 * Behavior-preserving move: the exact-match semantics —
 * `lower(trim(artist)) || '-' || lower(trim(coalesce(album,'')))` against
 * `flowsheet` rows where `album_id IS NOT NULL`, most-recent wins — are
 * unchanged. `apps/backend/services/album-metadata-lookup.service.ts` now
 * carries a thin re-export shim (`export { resolveLinkedAlbumId } from
 * '@wxyc/database';`) so its existing import site stays untouched, mirroring
 * the `@wxyc/legacy-mirror` (BS#1707) and `concerts-recompute.ts` (BS#1763)
 * extractions. `scripts/seed-critic-reviews.ts` imports this directly.
 */
import { sql, desc } from 'drizzle-orm';
import { db } from './client.js';
import { flowsheet } from './schema.js';

const flowsheetLookupKey = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

/**
 * JS-side normalized lookup key. The order of trim() and toLowerCase()
 * is irrelevant for the column shapes in flowsheet (artist names and
 * album titles are ASCII or Latin-1 in steady state), but match the SQL
 * literally for forward-compatibility with Unicode-bearing rows. PG's
 * `trim()` strips only ASCII space by default while JS `.trim()` strips
 * all Unicode whitespace — divergence can produce silent cache misses
 * on NBSP-padded inputs. Documented here so future maintainers see the
 * gap; aligning would require a generated column or a normalize_key()
 * SQL function (migration), so deferred.
 */
function lookupKey(artist: string, album?: string): string {
  return `${artist.toLowerCase().trim()}-${(album ?? '').toLowerCase().trim()}`;
}

/**
 * Resolve `(artistName, releaseTitle)` to the `library.id` of a matching
 * linked flowsheet row, or `null` when no `album_id`-bearing flowsheet row
 * exists for the key. Shared Step-1 for both the album-metadata read
 * (`lookupAlbumMetadataById`) and the critic-reviews read
 * (`lookupCriticReviewsByAlbumId`) in
 * `apps/backend/services/album-metadata-lookup.service.ts`. Callers that
 * need both — the `/proxy/metadata/album` handler — resolve the key *once*
 * here and pass the id to both reads, so a concurrent flowsheet insert can't
 * make the two reads disagree on which album they describe. The seed writer
 * (`scripts/seed-critic-reviews.ts`) imports this to key its UPSERTs against
 * the exact same normalized flowsheet key the serve path reads.
 *
 * Uses the partial functional index `flowsheet_album_link_lookup_idx`. The
 * explicit `flowsheet.album_id IS NOT NULL` predicate matches the index's
 * WHERE clause verbatim so the planner uses the partial index. `ORDER BY
 * flowsheet.id DESC LIMIT 1` makes the row-pick deterministic on
 * multi-album_id keys (V/A multi-format, dual-pressing, librarian
 * duplicates — verified to exist in the live `album_id` corpus). Two
 * requests for the same lookup key resolve to the same row, eliminating a
 * flapping-response edge that would otherwise let iOS see two different
 * albums for the same query across polls. Sort cost is bounded: the
 * most-popular key has hundreds of matches, not thousands; the post-filter
 * `id DESC` sort on the small match set is sub-ms in practice.
 *
 * An empty/whitespace-only `artistName` or `releaseTitle` short-circuits to
 * `null`: the key `'<artist>-'` (blank release) would otherwise match any
 * linked flowsheet row whose DJ left `album_title` blank and return an
 * arbitrary `album_id`.
 */
export async function resolveLinkedAlbumId(artistName: string, releaseTitle?: string): Promise<number | null> {
  const trimmedArtist = artistName.trim();
  const trimmedRelease = (releaseTitle ?? '').trim();
  if (trimmedArtist.length === 0 || trimmedRelease.length === 0) return null;

  const key = lookupKey(trimmedArtist, trimmedRelease);

  const candidate = await db
    .select({ album_id: flowsheet.album_id })
    .from(flowsheet)
    .where(sql`${flowsheetLookupKey} = ${key} AND ${flowsheet.album_id} IS NOT NULL`)
    .orderBy(desc(flowsheet.id))
    .limit(1);

  return candidate[0]?.album_id ?? null;
}
