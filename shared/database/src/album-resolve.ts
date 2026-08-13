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
 * The linked-flowsheet row shape both {@link resolveLinkedAlbumId} (the id
 * alone, for its existing external callers) and the proxy controller's
 * local-first base-field block (`record_label` / `label_id` /
 * `metadata_status`, BS#1827) need — see {@link selectLinkedFlowsheetRow}.
 */
export interface LinkedFlowsheetRow {
  album_id: number;
  record_label: string | null;
  label_id: number | null;
  metadata_status: string;
}

/**
 * Resolve `(artistName, releaseTitle)` to the matching linked flowsheet row
 * — `album_id` plus the base (non-enrichment) columns written onto that same
 * row at play time — or `null` when no `album_id`-bearing flowsheet row
 * exists for the key. The single shared query behind both
 * {@link resolveLinkedAlbumId} and the proxy controller's base-field block
 * (BS#1827): one round trip resolves album_id AND record_label/label_id/
 * metadata_status from the SAME row, so a concurrent flowsheet insert can't
 * make them describe two different rows for one request the way two
 * separate queries could (the bug this consolidation fixes — BS#1827 round
 * 2 review). `record_label`/`label_id` are written by the DJ, dj-site's
 * freeform entry, or the ETL and never depend on LML, unlike
 * `album_metadata.label` (Discogs enrichment, BS#1336); `metadata_status` is
 * reported faithfully off this row — a replayed/stale value here (e.g. a
 * re-aired play defaulting back to `pending`) is the terminal-semantics
 * question iOS#685 owns, not addressed by this function.
 *
 * Not part of the small public surface other workspaces import — only
 * {@link resolveLinkedAlbumId} (used by `jobs/album-critic-reviews-etl` and
 * `scripts/seed-critic-reviews.ts`, which need only the id) and the proxy
 * controller's re-export shim (which needs the whole row) call this
 * directly. Exported because both live outside this file, but treat it as
 * an internal accessor, not a third general-purpose resolver to reach for.
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
 * `id DESC` HERE MEANS "PICK A CONSISTENT WINNER," NOT "PICK THE NEWEST
 * PLAY" (BS#2118 site 6) — do not read this as a recency query. `id` is
 * insertion order, not airtime order, and this function does not care which
 * candidate row actually aired most recently; it only needs the same
 * candidate every time. That said, a historical insert (backfill, gap
 * import, repair) DOES change which row wins here once it acquires an
 * `album_id` — `jobs/legacy-linkage-resolve` links `flowsheet.album_id` on
 * its own 30-minute cron, independent of when the row was inserted — and the
 * winning row's `record_label` / `label_id` / `metadata_status` then come
 * from that historical row instead of whichever live row previously won.
 *
 * `record_label` and `label_id` are accepted as-is: DJ-entered or
 * ETL-written free text, not derived from *when* the row aired, so a
 * historical row's values are not wrong in the way a recency claim would
 * be — just a different, equally legitimate, source row for the same key.
 *
 * `metadata_status` is NOT the same kind of column and is NOT covered by
 * that argument — it is a `pgEnum` (`schema.ts`) written only by the
 * enrichment pipeline (`apps/enrichment-worker`), and it inherently makes a
 * temporal claim about the row (a `pending`/`enriching` value asserts
 * enrichment hasn't landed *yet* — see `proxy.controller.ts`'s
 * `NON_TERMINAL_METADATA_STATUSES` comment). Whether a replayed/stale value
 * here is acceptable is the terminal-semantics question iOS#685 already
 * owns and this function already declines to answer (see the base-field
 * paragraph above) — that pre-existing carve-out stands; this comment does
 * not relitigate it. What IS new here: a historical insert can make a
 * non-terminal (`pending`/`enriching`) row win the pick for a key whose
 * live row had already reached a terminal status. On the
 * `GET /proxy/metadata/album` hot path, the proxy controller treats a
 * non-terminal `metadataStatus` as uncacheable and skips
 * `albumMetadataCache.set` (`proxy.controller.ts`) — so for as long as that
 * historical row keeps winning and stays non-terminal, this key's 1-hour
 * album-metadata memo is suppressed. Reachable by the #2119 cohort.
 *
 * If a future caller needs "the row that actually aired most recently"
 * instead of "a stable pick," that is a different query (order by
 * `add_time`, with `id` as its own tie-break — see `getEntriesByPage`'s
 * comment for why `add_time` alone is not unique), not a change to this
 * one.
 *
 * An empty/whitespace-only `artistName` or `releaseTitle` short-circuits to
 * `null`: the key `'<artist>-'` (blank release) would otherwise match any
 * linked flowsheet row whose DJ left `album_title` blank and return an
 * arbitrary `album_id`.
 *
 * A free-text row that has NEVER linked to an `album_id` has no row this
 * query can find either — the partial index is deliberately scoped to
 * `album_id IS NOT NULL` (migration 0081); an equivalent covering the pure
 * free-text cohort would need its own (much larger, whole-table) index,
 * which is out of scope here. Callers fall back to the request's own
 * artist/release/track strings for that cohort — see the proxy controller's
 * doc comment.
 */
export async function selectLinkedFlowsheetRow(
  artistName: string,
  releaseTitle?: string
): Promise<LinkedFlowsheetRow | null> {
  const trimmedArtist = artistName.trim();
  const trimmedRelease = (releaseTitle ?? '').trim();
  if (trimmedArtist.length === 0 || trimmedRelease.length === 0) return null;

  const key = lookupKey(trimmedArtist, trimmedRelease);

  const candidate = await db
    .select({
      album_id: flowsheet.album_id,
      record_label: flowsheet.record_label,
      label_id: flowsheet.label_id,
      metadata_status: flowsheet.metadata_status,
    })
    .from(flowsheet)
    .where(sql`${flowsheetLookupKey} = ${key} AND ${flowsheet.album_id} IS NOT NULL`)
    .orderBy(desc(flowsheet.id))
    .limit(1);

  const row = candidate[0];
  // The WHERE clause already guarantees album_id IS NOT NULL for any
  // returned row; the null check here is a defensive type-narrowing (not a
  // reachable runtime branch) so `LinkedFlowsheetRow.album_id` can be typed
  // as a definite `number` rather than `number | null`.
  if (!row || row.album_id === null) return null;
  return {
    album_id: row.album_id,
    record_label: row.record_label,
    label_id: row.label_id,
    metadata_status: row.metadata_status,
  };
}

/**
 * Resolve `(artistName, releaseTitle)` to the `library.id` of a matching
 * linked flowsheet row, or `null` when no `album_id`-bearing flowsheet row
 * exists for the key. Thin wrapper over {@link selectLinkedFlowsheetRow} —
 * kept as its own named export with this exact `number | null` signature so
 * its existing external callers (`jobs/album-critic-reviews-etl`,
 * `scripts/seed-critic-reviews.ts`, and their test suites) are untouched by
 * the BS#1827 consolidation. Shared Step-1 for both the album-metadata read
 * (`lookupAlbumMetadataById`) and the critic-reviews read
 * (`lookupCriticReviewsByAlbumId`) in
 * `apps/backend/services/album-metadata-lookup.service.ts`. The seed writer
 * (`scripts/seed-critic-reviews.ts`) imports this to key its UPSERTs against
 * the exact same normalized flowsheet key the serve path reads.
 */
export async function resolveLinkedAlbumId(artistName: string, releaseTitle?: string): Promise<number | null> {
  const row = await selectLinkedFlowsheetRow(artistName, releaseTitle);
  return row?.album_id ?? null;
}
