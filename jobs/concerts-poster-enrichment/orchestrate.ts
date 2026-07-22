/**
 * Orchestrator for jobs/concerts-poster-enrichment (BS#1743).
 *
 * Unit of work: `(concert row missing a poster → its resolved headliner's
 * Discogs artist image → concerts.image_url)`. Loads the candidate concert
 * rows (`image_url IS NULL` + a resolvable headliner Discogs id, upcoming
 * window), DEDUPES them by headliner Discogs id (an artist billed on
 * multiple upcoming shows gets exactly one `getArtistDetails` call), pages
 * the deduped artist list, fetches each artist's image via the dep-injected
 * `fetchArtistImage` (LML's `getArtistDetails`, BS#1743), and writes the
 * fetched image onto every concert row that shares that headliner.
 *
 * Unlike the genre sibling (`jobs/concerts-genre-enrichment/orchestrate.ts`),
 * there is no bulk endpoint here — `getArtistDetails` is a single-artist
 * call — so paging exists purely to pace the cooperative-pause probe and log
 * cadence; the per-call concurrency/rate ceiling is enforced by the
 * dep-injected fetch function's own limiter (`lml-limiter.ts`), not by page
 * shape. Each artist's fetch is awaited independently (`Promise.allSettled`)
 * so one artist's failure can't take down the rest of the page.
 *
 * Retryability: there is no negative cache for "artist has no Discogs image"
 * — unlike the genre sibling's `artist_metadata` anti-join, this job's only
 * storage is `concerts.image_url` itself, and the issue's resolved design
 * deliberately adds no new table/column to remember a null verdict. A
 * no-image artist's concert rows simply stay candidates (still `image_url
 * IS NULL`) and are re-queried every run until the source scrape captures a
 * poster or Discogs gains an image — bounded because the candidate window is
 * the small upcoming-show cohort and every fetch is rate-limited. A THROWN
 * fetch (`skipped_no_artist`: transport failure, LML/Discogs error) behaves
 * the same way — no row written, naturally retried next run via the same
 * `image_url IS NULL` predicate. There is no attempt-at marker to manage.
 *
 * Dep-injected so the unit suite drives the loop without PG or LML — see
 * tests/unit/jobs/concerts-poster-enrichment/orchestrate.test.ts.
 */

import type { EnrichmentCandidate } from './query.js';
import type { ConcertImageRow } from './writer.js';
import { captureError, log } from './logger.js';

export type Totals = {
  /** Concert rows selected (image_url IS NULL, resolvable headliner, in window). */
  candidates: number;
  /** Distinct headliner artists to query (deduped by Discogs id). */
  artists: number;
  /** Pages of artists actually sent to the fetcher. */
  pages: number;
  /** Artist-details calls that returned a response (image present or not). */
  fetched: number;
  /** Concert rows actually written with a new poster image. */
  enriched: number;
  /** Concert rows skipped because the resolved artist has no (or a blank) Discogs image. */
  skipped_no_image: number;
  /** Concert rows skipped because the artist-details fetch itself threw (left retryable). */
  skipped_no_artist: number;
  /** DB write failures (rows left retryable). */
  errors: number;
};

export const emptyTotals = (): Totals => ({
  candidates: 0,
  artists: 0,
  pages: 0,
  fetched: 0,
  enriched: 0,
  skipped_no_image: 0,
  skipped_no_artist: 0,
  errors: 0,
});

export interface EnrichDeps {
  /** Concert rows missing a poster, with a resolvable headliner Discogs id. */
  loadCandidates: () => Promise<EnrichmentCandidate[]>;
  /** One artist's Discogs image lookup (LML `getArtistDetails`, limiter-gated). */
  fetchArtistImage: (discogsArtistId: number) => Promise<{ image_url: string | null }>;
  /** Persist a batch of resolved images; returns the count of concert rows written. */
  writeImages: (rows: ConcertImageRow[]) => Promise<{ updated: number }>;
  /** Cooperative pause — awaited before each page. */
  awaitQuiet?: () => Promise<void>;
}

export interface EnrichOptions {
  pageSize: number;
  dryRun: boolean;
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Group candidates by headliner Discogs id, preserving first-seen order. */
const groupByArtist = (candidates: EnrichmentCandidate[]): Map<number, number[]> => {
  const byArtist = new Map<number, number[]>();
  for (const c of candidates) {
    const ids = byArtist.get(c.discogs_artist_id);
    if (ids) {
      ids.push(c.concert_id);
    } else {
      byArtist.set(c.discogs_artist_id, [c.concert_id]);
    }
  }
  return byArtist;
};

export const runEnrichment = async (deps: EnrichDeps, options: EnrichOptions): Promise<Totals> => {
  const totals = emptyTotals();

  const candidates = await deps.loadCandidates();
  totals.candidates = candidates.length;

  const byArtist = groupByArtist(candidates);
  const artistIds = [...byArtist.keys()];
  totals.artists = artistIds.length;

  const pages = chunk(artistIds, options.pageSize);
  log('info', 'enumerated', `${candidates.length} concerts (${artistIds.length} distinct headliners) need posters`, {
    candidates: candidates.length,
    artists: artistIds.length,
    planned_pages: pages.length,
    page_size: options.pageSize,
  });

  if (options.dryRun) {
    log(
      'info',
      'dry_run_plan',
      `(dry-run) would fetch ${artistIds.length} artist images across ${pages.length} pages`,
      {
        planned_pages: pages.length,
      }
    );
    return totals;
  }

  for (const page of pages) {
    if (deps.awaitQuiet) await deps.awaitQuiet();

    const settled = await Promise.allSettled(page.map((artistId) => deps.fetchArtistImage(artistId)));

    const rows: ConcertImageRow[] = [];
    for (let i = 0; i < page.length; i++) {
      const artistId = page[i];
      const concertIds = byArtist.get(artistId) ?? [];
      const outcome = settled[i];

      if (outcome.status === 'rejected') {
        // Transport / LML / Discogs failure for this one artist: nothing
        // written, its concert rows stay `image_url IS NULL` and are
        // re-selected next run (the candidate predicate is the retry
        // substrate). Never abort the run over one artist.
        totals.skipped_no_artist += concertIds.length;
        log('warn', 'artist_fetch_failed', `getArtistDetails threw for discogs_artist_id ${artistId}; left retryable`, {
          discogs_artist_id: artistId,
          concert_count: concertIds.length,
          error_message:
            outcome.reason instanceof Error
              ? `${outcome.reason.name}: ${outcome.reason.message}`
              : String(outcome.reason),
        });
        captureError(outcome.reason, 'artist_fetch_failed', { discogs_artist_id: artistId });
        continue;
      }

      totals.fetched += 1;
      const imageUrl = outcome.value.image_url;
      if (!imageUrl || imageUrl.trim() === '') {
        // A real, responded verdict with no (or blank) Discogs image. There
        // is no negative cache to persist here (see the module docblock), so
        // this artist's concerts stay candidates and are re-asked next run.
        totals.skipped_no_image += concertIds.length;
        continue;
      }

      rows.push({ discogs_artist_id: artistId, concert_ids: concertIds, image_url: imageUrl });
    }

    totals.pages += 1;

    if (rows.length === 0) continue;

    try {
      const { updated } = await deps.writeImages(rows);
      totals.enriched += updated;
    } catch (err) {
      // A write failure leaves this page's concert rows un-enriched
      // (`image_url` still NULL → retryable next run). Count and continue.
      const rowConcertCount = rows.reduce((sum, r) => sum + r.concert_ids.length, 0);
      totals.errors += rowConcertCount;
      log('warn', 'write_failed', `concerts.image_url UPDATE threw for a page of ${rows.length} artist(s)`, {
        artists_in_page: rows.length,
        concert_count: rowConcertCount,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'write_failed', { artists_in_page: rows.length });
    }
  }

  return totals;
};
