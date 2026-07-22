/**
 * Orchestrator for jobs/concerts-genre-enrichment (BS#1624).
 *
 * Unit of work: `(resolved headliner artist → Discogs genres → artist_metadata
 * row)`. Loads the candidate artists (resolved headliners lacking a genre row),
 * pages them through LML's bulk artist-genres endpoint (LML#781), and UPSERTs
 * the verdicts. Verdict routing keys on LML's `source`: `cache`/`discogs_api`/
 * `not_found` persist a row (an empty-genre `not_found` is a legitimate
 * "enriched, no genres" terminal row); `unavailable` — LML couldn't reach
 * Discogs (no token, saturation breaker open, transient failure) — is skipped
 * so the artist keeps no row and is retried, never negative-cached.
 *
 * Retryability: a page whose LML call THROWS (transport failure / timeout /
 * 5xx) is skipped with nothing written; those artists keep no `artist_metadata`
 * row and are re-selected on the next run (the candidate anti-join is the
 * retry substrate — there is no attempt-at marker to manage, unlike the
 * resolver). A per-artist `unavailable` verdict is treated the same way (no row
 * written → retried). A row IS written for a confirmed genre-less artist
 * (`not_found` / empty `cache` verdict) — that is the terminal negative-cache.
 *
 * Dep-injected so the unit suite drives the loop without PG or LML — see
 * tests/unit/jobs/concerts-genre-enrichment/orchestrate.test.ts. The LML
 * request/response shape is the shipped LML#781 contract carried by
 * `fetchArtistGenresBulk` (@wxyc/lml-client).
 */

import type { ArtistGenresBulkResponse, ArtistGenresRequestItem } from '@wxyc/lml-client';
import type { EnrichmentCandidate } from './query.js';
import type { ArtistGenresRow } from './writer.js';
import { captureError, log } from './logger.js';

export type Totals = {
  /** Resolved-but-unenriched artists loaded (deduped by Discogs id). */
  candidates: number;
  /** LML pages that received a response. */
  pages: number;
  /** Artist verdicts received across all responded pages. */
  fetched: number;
  /** Of `fetched`, how many carried >= 1 genre. */
  with_genres: number;
  /** Of `fetched`, verdicts with `source: 'unavailable'` — skipped, left retryable. */
  unavailable_skipped: number;
  /** `artist_metadata` rows actually inserted (a re-run over an enriched set → 0). */
  enriched: number;
  /** Page-level transport failures (per artist) + write failures. */
  errors: number;
  /** Set when a whole page came back `unavailable` (breaker open) and the run stopped short. */
  stopped_early: boolean;
};

export const emptyTotals = (): Totals => ({
  candidates: 0,
  pages: 0,
  fetched: 0,
  with_genres: 0,
  unavailable_skipped: 0,
  enriched: 0,
  errors: 0,
  stopped_early: false,
});

export interface EnrichDeps {
  /** Resolved headliners lacking a genre row (deduped by Discogs id). */
  loadCandidates: () => Promise<EnrichmentCandidate[]>;
  /** One LML page. The client validates 1:1 index alignment before returning. */
  fetchGenres: (items: ArtistGenresRequestItem[]) => Promise<ArtistGenresBulkResponse>;
  /** Persist a batch of verdicts (ON CONFLICT DO NOTHING); returns rows inserted. */
  upsert: (rows: ArtistGenresRow[]) => Promise<{ inserted: number }>;
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

export const runEnrichment = async (deps: EnrichDeps, options: EnrichOptions): Promise<Totals> => {
  const totals = emptyTotals();

  const candidates = await deps.loadCandidates();
  totals.candidates = candidates.length;

  const pages = chunk(candidates, options.pageSize);
  log('info', 'enumerated', `${candidates.length} resolved headliners need genres`, {
    candidates: candidates.length,
    planned_pages: pages.length,
    page_size: options.pageSize,
  });

  if (options.dryRun) {
    log('info', 'dry_run_plan', `(dry-run) would send ${pages.length} pages of up to ${options.pageSize} artists`, {
      planned_pages: pages.length,
    });
    return totals;
  }

  for (const page of pages) {
    if (deps.awaitQuiet) await deps.awaitQuiet();

    let response: ArtistGenresBulkResponse;
    try {
      response = await deps.fetchGenres(
        page.map((c) => ({ artist_name: c.artist_name, discogs_artist_id: c.discogs_artist_id }))
      );
    } catch (err) {
      // Transport failure: nothing written, the whole page's artists keep no
      // row and are re-selected next run (the candidate anti-join is the retry
      // substrate). Never abort the run over one page.
      totals.errors += page.length;
      log('warn', 'page_failed', `fetchArtistGenresBulk threw; page of ${page.length} left retryable`, {
        page_size: page.length,
        first_discogs_artist_id: page[0]?.discogs_artist_id ?? null,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'page_failed', { page_size: page.length });
      continue;
    }
    totals.pages += 1;

    // Zip verdicts to candidates positionally (the client already validated
    // results.length === page.length, so this is safe). Build the write batch.
    const rows: ArtistGenresRow[] = [];
    let pageUnavailable = 0;
    for (let i = 0; i < page.length; i++) {
      const verdict = response.results[i];
      totals.fetched += 1;
      // `unavailable` = LML couldn't reach Discogs (no token / breaker open /
      // transient). Skip the write so the artist keeps no `artist_metadata` row
      // and the candidate anti-join re-selects it next run. Persisting even the
      // empty verdict would negative-cache a couldn't-ask permanently. A
      // `not_found` verdict, by contrast, is a genuine "Discogs has no genres"
      // and DOES persist (an empty row is a real, terminal negative-cache).
      if (verdict.source === 'unavailable') {
        totals.unavailable_skipped += 1;
        pageUnavailable += 1;
        continue;
      }
      const genres = verdict.genres ?? [];
      const styles = verdict.styles ?? [];
      if (genres.length > 0) totals.with_genres += 1;
      rows.push({
        discogs_artist_id: page[i].discogs_artist_id,
        genres,
        styles,
        artist_bio: verdict.bio ?? null,
      });
    }

    // A page that comes back entirely `unavailable` means LML's Discogs breaker
    // is open (no token / saturation) and short-circuited every verdict; later
    // pages would just waste round-trips against the same open breaker. Stop the
    // run — the whole candidate set stays retryable via the anti-join, and `rows`
    // is empty so there is nothing to write. (Mirrors concerts-artist-lml-
    // resolver's all-escalation early-stop.)
    if (page.length > 0 && pageUnavailable === page.length) {
      totals.stopped_early = true;
      log('info', 'stopped_early', `page of ${page.length} came back all-unavailable (breaker open); stopping run`, {
        page_size: page.length,
        pages_done: totals.pages,
      });
      break;
    }

    try {
      const { inserted } = await deps.upsert(rows);
      totals.enriched += inserted;
    } catch (err) {
      // A write failure leaves the page's artists unenriched (no row →
      // retryable next run). Count and continue.
      totals.errors += rows.length;
      log('warn', 'upsert_failed', `artist_metadata UPSERT threw for a page of ${rows.length}`, {
        page_size: rows.length,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'upsert_failed', { page_size: rows.length });
    }
  }

  return totals;
};
