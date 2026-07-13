/**
 * Orchestrator for jobs/concerts-artist-lml-resolver (BS#1614).
 *
 * Role-agnostic unit of work: `(raw_name → verdict → row targets)`. The
 * orchestrator owns resolution — gate, dedupe, paging, verdict routing —
 * while each {@link RoleTarget} owns its own candidate loading and write
 * fan-out. Today the only target is the concerts headliner
 * (`targets.ts#headlinerTarget`); BS#1618 Phase D registers
 * `concert_performers` junction rows as a second target without touching
 * this loop, and a name billed in both roles is resolved ONCE (targets
 * share the per-name dedupe).
 *
 * Verdict routing implements the LML#759 retryability contract
 * (docs/migrations.md "Attempt-at markers"):
 *
 *   - resolved            → `applyResolved` (id + provenance + marker, and
 *                           the target may FK-loop-close).
 *   - ambiguous/not_found → `applyNoMatch` (marker only — a RESPONDED
 *                           no-match arms the TTL retry window).
 *   - escalation_unavailable → NO write. LML couldn't ask (breaker open /
 *                           outage / 429), so the marker stays NULL and the
 *                           row is immediately eligible next run. A page
 *                           whose verdicts are ALL escalation_unavailable
 *                           stops the run early — the breaker is open and
 *                           later pages would waste round-trips.
 *   - thrown resolveBatch → NO write (transport failure, same retryability
 *                           as escalation_unavailable), run continues to
 *                           the next page.
 *
 * Dedupe is on the VERBATIM raw name (LML additionally dedupes on the
 * identity-match form server-side); the write fan-out targets the row ids
 * collected at candidate time, NULL-guarded by each target so a row another
 * arm resolved mid-run is left untouched (`raced` counter).
 *
 * Dep-injected so the unit suite drives the loop without PG or LML — see
 * tests/unit/jobs/concerts-artist-lml-resolver/orchestrate.test.ts.
 */

import type { ArtistResolveBulkResponse, ArtistResolveMethod } from '@wxyc/lml-client';
import { captureError, log } from './logger.js';

/** One DB row still needing resolution for some role. */
export type TargetCandidate = { id: number; raw_name: string };

/** The subset of a resolved LML verdict a target needs to persist. */
export type ResolvedVerdict = {
  discogs_artist_id: number;
  method: ArtistResolveMethod | undefined;
};

/**
 * A role-specific set of rows to resolve (headliner today; BS#1618's
 * supporting-act junction rows later). The orchestrator never composes SQL —
 * targets own their predicates and their NULL-guarded write fan-out.
 */
export interface RoleTarget {
  /** Stable label for counters/logging, e.g. 'headliner'. */
  role: string;
  /** Rows still needing resolution: never-attempted, or no-match past the TTL. */
  loadCandidates(ttlDays: number): Promise<TargetCandidate[]>;
  /**
   * Fan one resolved verdict onto rows. Every UPDATE must be NULL-guarded so
   * the target only fills NULLs, never overwrites. Returns rows actually
   * updated plus how many of those also had a library FK loop-closed.
   */
  applyResolved(rowIds: number[], verdict: ResolvedVerdict): Promise<{ updated: number; fk_loop_closed: number }>;
  /** Stamp the attempt-at marker on a responded no-match (ambiguous | not_found). */
  applyNoMatch(rowIds: number[]): Promise<{ updated: number }>;
}

export type Totals = {
  /** Candidate rows loaded across all targets. */
  candidates: number;
  /** Candidate rows withheld by the clean-name gate. */
  gated_out: number;
  /** Deduped clean names sent (or, dry-run, that would be sent) to LML. */
  names: number;
  /** Pages that received an LML response. */
  pages: number;
  /** Names resolved to a Discogs artist id. */
  resolved: number;
  /** Rows updated by resolved verdicts (fan-out can exceed `resolved`). */
  rows_resolved: number;
  /** Rows whose `headlining_artist_id` FK was also loop-closed. */
  fk_loop_closed: number;
  /** Names LML reported ambiguous (responded — marker stamped). */
  ambiguous: number;
  /** Names LML reported not_found (responded — marker stamped). */
  not_found: number;
  /** Names LML couldn't ask about (retryable — NO marker). */
  escalation_unavailable: number;
  /** Page-level transport failures (per name) + per-name write failures. */
  errors: number;
  /** Rows skipped by a target's NULL-guard (another arm resolved them mid-run). */
  raced: number;
  /** True when an all-escalation page stopped the run early. */
  early_stopped: boolean;
};

export const emptyTotals = (): Totals => ({
  candidates: 0,
  gated_out: 0,
  names: 0,
  pages: 0,
  resolved: 0,
  rows_resolved: 0,
  fk_loop_closed: 0,
  ambiguous: 0,
  not_found: 0,
  escalation_unavailable: 0,
  errors: 0,
  raced: 0,
  early_stopped: false,
});

export interface RunDeps {
  targets: RoleTarget[];
  /** The clean-name API-budget gate (`isCleanHeadliner`). */
  gate: (name: string) => boolean;
  /** One LML page. The client validates 1:1 index alignment before returning. */
  resolveBatch: (names: string[]) => Promise<ArtistResolveBulkResponse>;
  /** Cooperative pause — awaited before each page. */
  awaitQuiet?: () => Promise<void>;
}

export interface RunOptions {
  pageSize: number;
  ttlDays: number;
  dryRun: boolean;
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Per-name registry of which targets carry which row ids. */
type NameEntry = Map<RoleTarget, number[]>;

export const runResolve = async (deps: RunDeps, options: RunOptions): Promise<Totals> => {
  const totals = emptyTotals();

  // -- Load + gate + dedupe ---------------------------------------------------
  // Insertion order follows each target's ORDER BY, so page composition is
  // deterministic across runs (same candidate set → same pages).
  const byName = new Map<string, NameEntry>();
  for (const target of deps.targets) {
    const candidates = await target.loadCandidates(options.ttlDays);
    totals.candidates += candidates.length;
    for (const candidate of candidates) {
      if (!deps.gate(candidate.raw_name)) {
        totals.gated_out += 1;
        continue;
      }
      let entry = byName.get(candidate.raw_name);
      if (!entry) {
        entry = new Map();
        byName.set(candidate.raw_name, entry);
      }
      const ids = entry.get(target);
      if (ids) {
        ids.push(candidate.id);
      } else {
        entry.set(target, [candidate.id]);
      }
    }
  }
  totals.names = byName.size;

  const pages = chunk([...byName.keys()], options.pageSize);
  log('info', 'enumerated', `${totals.candidates} candidates → ${totals.names} clean deduped names`, {
    candidates: totals.candidates,
    gated_out: totals.gated_out,
    names: totals.names,
    planned_pages: pages.length,
    page_size: options.pageSize,
  });

  if (options.dryRun) {
    log('info', 'dry_run_plan', `(dry-run) would send ${pages.length} pages of up to ${options.pageSize} names`, {
      planned_pages: pages.length,
    });
    return totals;
  }

  // -- Serial pages -------------------------------------------------------
  for (const page of pages) {
    if (deps.awaitQuiet) await deps.awaitQuiet();

    let response: ArtistResolveBulkResponse;
    try {
      response = await deps.resolveBatch(page);
    } catch (err) {
      // Transport failure: nothing was written, the whole page's rows keep a
      // NULL marker and stay retryable — same contract as
      // escalation_unavailable, so no dead-letter state to manage.
      totals.errors += page.length;
      log('warn', 'page_failed', `resolveArtistNamesBulk threw; page of ${page.length} left retryable`, {
        page_size: page.length,
        first_name: page[0] ?? null,
        error_message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      captureError(err, 'page_failed', { page_size: page.length });
      continue;
    }
    totals.pages += 1;

    let pageEscalations = 0;
    for (let i = 0; i < page.length; i++) {
      const name = page[i];
      const result = response.results[i];
      const entry = byName.get(name) as NameEntry;

      if (typeof result.discogs_artist_id === 'number') {
        totals.resolved += 1;
        for (const [target, ids] of entry) {
          try {
            const { updated, fk_loop_closed } = await target.applyResolved(ids, {
              discogs_artist_id: result.discogs_artist_id,
              method: result.method,
            });
            totals.rows_resolved += updated;
            totals.fk_loop_closed += fk_loop_closed;
            totals.raced += ids.length - updated;
          } catch (err) {
            // A write failure leaves the rows untouched (marker NULL,
            // retryable next run) — never abort the page over one name.
            totals.errors += 1;
            captureError(err, 'apply_resolved_failed', { role: target.role, name });
          }
        }
      } else if (result.unresolved_reason === 'ambiguous' || result.unresolved_reason === 'not_found') {
        if (result.unresolved_reason === 'ambiguous') {
          totals.ambiguous += 1;
        } else {
          totals.not_found += 1;
        }
        for (const [target, ids] of entry) {
          try {
            const { updated } = await target.applyNoMatch(ids);
            totals.raced += ids.length - updated;
          } catch (err) {
            totals.errors += 1;
            captureError(err, 'apply_no_match_failed', { role: target.role, name });
          }
        }
      } else if (result.unresolved_reason === 'escalation_unavailable') {
        // "Couldn't ask," not "asked and missed" — write NOTHING so the rows
        // stay marker-NULL and immediately retryable (LML#759 contract).
        totals.escalation_unavailable += 1;
        pageEscalations += 1;
      } else {
        // Neither a resolved id nor a known unresolved_reason: a future LML
        // verdict shape. Writing nothing is the safe default (row stays
        // retryable); the counter + warn make the drift visible.
        totals.errors += 1;
        log('warn', 'unknown_verdict', `unrecognized verdict for ${JSON.stringify(name)}; skipping write`, {
          unresolved_reason: result.unresolved_reason ?? null,
        });
      }
    }

    if (pageEscalations === page.length && page.length > 0) {
      // Mid-batch breaker trip short-circuits LML-side: every remaining page
      // would come back all-escalation too. Stop; tonight's residual retries
      // tomorrow via the NULL marker.
      totals.early_stopped = true;
      log('warn', 'early_stop', 'entire page returned escalation_unavailable; stopping run (breaker open)', {
        pages_sent: totals.pages,
        planned_pages: pages.length,
      });
      break;
    }
  }

  return totals;
};
