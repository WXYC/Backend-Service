/**
 * Bio backfill orchestrator for jobs/concerts-genre-enrichment (BS#1734).
 *
 * The nightly candidate query (query.ts `loadEnrichmentCandidates`) anti-joins
 * on "no `artist_metadata` row at all", so it never revisits an artist BS#1624
 * already enriched with genres/styles — meaning rows created before the
 * `artist_bio` column shipped never pick up a bio from the nightly run or from
 * `--backfill` (same anti-join). This is the one-time pass that fills them:
 * `loadBioBackfillCandidates` selects `discogs_artist_id WHERE artist_bio IS
 * NULL`, re-queries the SAME LML bulk artist-genres endpoint (bio rides
 * genres/styles, LML#889), and `applyBioBackfill` writes a fill-null-only
 * UPDATE. Deliberately does NOT touch genres/styles on these rows (BS#1624
 * already populated them) and does NOT widen the nightly candidate anti-join.
 *
 * Only a verdict carrying a real (non-empty) bio is written — that row then has
 * `artist_bio IS NOT NULL` and drops out of the candidate set for good. Two
 * verdict shapes are skipped and leave the row `NULL`-retryable: `source:
 * 'unavailable'` (LML couldn't reach Discogs — transient) and a responded but
 * blank/absent profile (Discogs genuinely has no bio). Writing the latter as
 * NULL would achieve nothing (the candidate query keys on `artist_bio IS
 * NULL`), so the skip avoids a pointless self-UPDATE. The consequence: a
 * blank-profile artist is re-attempted on every re-run — this pass does NOT
 * converge to a no-op re-run, which is acceptable for a one-time MANUAL job
 * (bounded, rate-limited) but is why it must never be scheduled as a cron. True
 * convergence would need a `bio_attempted_at` marker (deferred, out of scope).
 *
 * Same page/fetch/skip-unavailable/stop-early control flow as `orchestrate.ts`
 * (kept as a sibling function rather than folded in, since the two write
 * completely different columns via different statements) — see that file for
 * the breaker-open early-stop rationale this mirrors.
 *
 * Dep-injected so the unit suite drives the loop without PG or LML — see
 * tests/unit/jobs/concerts-genre-enrichment/bio-backfill.test.ts.
 */

import type { ArtistGenresBulkResponse, ArtistGenresRequestItem } from '@wxyc/lml-client';
import type { EnrichmentCandidate } from './query.js';
import type { BioBackfillRow } from './writer.js';
import { captureError, log } from './logger.js';

export type BioBackfillTotals = {
  /** `artist_metadata` rows lacking a bio (deduped by Discogs id). */
  candidates: number;
  /** LML pages that received a response. */
  pages: number;
  /** Artist verdicts received across all responded pages. */
  fetched: number;
  /** `artist_metadata` rows actually updated (a re-run over a filled set → 0). */
  updated: number;
  /** Of `fetched`, verdicts with `source: 'unavailable'` — skipped, left retryable. */
  unavailable_skipped: number;
  /** Of `fetched`, responded verdicts with a blank/absent bio — skipped, left `NULL`-retryable. */
  no_bio_skipped: number;
  /** Page-level transport failures (per artist) + write failures. */
  errors: number;
  /** Set when a whole page came back `unavailable` (breaker open) and the run stopped short. */
  stopped_early: boolean;
};

export const emptyBioBackfillTotals = (): BioBackfillTotals => ({
  candidates: 0,
  pages: 0,
  fetched: 0,
  updated: 0,
  unavailable_skipped: 0,
  no_bio_skipped: 0,
  errors: 0,
  stopped_early: false,
});

export interface BioBackfillDeps {
  /** Existing `artist_metadata` rows lacking a bio (deduped by Discogs id). */
  loadCandidates: () => Promise<EnrichmentCandidate[]>;
  /** One LML page. The client validates 1:1 index alignment before returning. */
  fetchGenres: (items: ArtistGenresRequestItem[]) => Promise<ArtistGenresBulkResponse>;
  /** Fill-null bio UPDATE (never overwrites a populated value); returns rows updated. */
  applyBioBackfill: (rows: BioBackfillRow[]) => Promise<{ updated: number }>;
  /** Cooperative pause — awaited before each page. */
  awaitQuiet?: () => Promise<void>;
}

export interface BioBackfillOptions {
  pageSize: number;
  dryRun: boolean;
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const runBioBackfill = async (
  deps: BioBackfillDeps,
  options: BioBackfillOptions
): Promise<BioBackfillTotals> => {
  const totals = emptyBioBackfillTotals();

  const candidates = await deps.loadCandidates();
  totals.candidates = candidates.length;

  const pages = chunk(candidates, options.pageSize);
  log('info', 'bio_backfill_enumerated', `${candidates.length} artist_metadata rows need a bio backfill`, {
    candidates: candidates.length,
    planned_pages: pages.length,
    page_size: options.pageSize,
  });

  if (options.dryRun) {
    log(
      'info',
      'bio_backfill_dry_run_plan',
      `(dry-run) would send ${pages.length} pages of up to ${options.pageSize} artists`,
      { planned_pages: pages.length }
    );
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
      // Transport failure: nothing written, the whole page's artists keep
      // `artist_bio IS NULL` and are re-selected next run (the candidate query
      // is the retry substrate).
      totals.errors += page.length;
      log('warn', 'bio_backfill_page_failed', `fetchArtistGenresBulk threw; page of ${page.length} left retryable`, {
        page_size: page.length,
        first_discogs_artist_id: page[0]?.discogs_artist_id ?? null,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'bio_backfill_page_failed', { page_size: page.length });
      continue;
    }
    totals.pages += 1;

    const rows: BioBackfillRow[] = [];
    let pageUnavailable = 0;
    for (let i = 0; i < page.length; i++) {
      const verdict = response.results[i];
      totals.fetched += 1;
      // `unavailable` = LML couldn't reach Discogs (transient). Skip the write so
      // the row keeps `artist_bio IS NULL` and the candidate query re-selects it
      // next run — and count it toward `pageUnavailable` so an all-unavailable
      // page trips the breaker-open early stop below.
      if (verdict.source === 'unavailable') {
        totals.unavailable_skipped += 1;
        pageUnavailable += 1;
        continue;
      }
      // Responded, but Discogs has no profile text. Writing NULL would be a
      // pointless self-UPDATE (the candidate query keys on `artist_bio IS
      // NULL`), so skip it — the row stays NULL-retryable, exactly like a
      // populated-bio artist stays terminal. NOT a breaker signal, so this does
      // NOT count toward `pageUnavailable`.
      const bio = verdict.bio ?? null;
      if (bio === null || bio === '') {
        totals.no_bio_skipped += 1;
        continue;
      }
      rows.push({ discogs_artist_id: page[i].discogs_artist_id, artist_bio: bio });
    }

    // A page that comes back entirely `unavailable` means LML's Discogs breaker
    // is open; later pages would just waste round-trips. Stop the run — the
    // whole candidate set stays retryable, and `rows` is empty so there is
    // nothing to write. Mirrors orchestrate.ts's identical guard.
    if (page.length > 0 && pageUnavailable === page.length) {
      totals.stopped_early = true;
      log(
        'info',
        'bio_backfill_stopped_early',
        `page of ${page.length} came back all-unavailable (breaker open); stopping run`,
        { page_size: page.length, pages_done: totals.pages }
      );
      break;
    }

    try {
      const { updated } = await deps.applyBioBackfill(rows);
      totals.updated += updated;
    } catch (err) {
      // A write failure leaves the page's rows at `artist_bio IS NULL` (retryable).
      totals.errors += rows.length;
      log('warn', 'bio_backfill_update_failed', `artist_metadata bio UPDATE threw for a page of ${rows.length}`, {
        page_size: rows.length,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'bio_backfill_update_failed', { page_size: rows.length });
    }
  }

  return totals;
};
