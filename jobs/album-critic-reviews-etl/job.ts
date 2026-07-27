/**
 * Entry point for the album-critic-reviews-etl job (BS#1830,
 * album-critic-reviews slice / ADR 0012).
 *
 * Weekly pull of the `manifest-latest` release asset published by
 * `WXYC/research-data` into `album_critic_reviews`: matches each
 * `CorpusItem` to a linked library album via the shared exact resolver,
 * extracts a <=300-char attributed snippet with Haiku for NEW items only
 * (anti-joined against already-seeded `(album_id, source_url)` pairs before
 * any LLM call), and idempotently UPSERTs. See `orchestrate.ts` for the
 * full pipeline shape and run guards, and the job README for the manifest
 * contract, dedup ranking, and invariants.
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json (`10 7 * * 0` UTC, weekly Sunday). Container runs to
 * completion. No cooperative pause: the job writes only
 * `album_critic_reviews` (never flowsheet-adjacent), matching the
 * `album-reviews-etl` donor's rationale.
 *
 * Required env: `RESEARCH_DATA_TOKEN` (always — even DRY_RUN needs the real
 * manifest), `ANTHROPIC_API_KEY` (unless DRY_RUN — DRY_RUN makes zero LLM
 * calls, so no key is needed to validate a run), + the standard `DB_*` set.
 * Optional: `DRY_RUN`, `SENTRY_DSN`. See docs/env-vars.md.
 */

import Anthropic from '@anthropic-ai/sdk';
import { closeDatabaseConnection } from '@wxyc/database';
import { runEtl, resolveDryRun } from './orchestrate.js';
import { resolveResearchDataToken, fetchManifestAsset, gunzipManifest } from './fetch.js';
import { matchItem } from './match.js';
import { loadExistingPairs } from './antijoin.js';
import { llmExtract, type AnthropicLike, type Extraction } from './extract.js';
import { upsertRow } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';
import type { CorpusItem } from './manifest.js';

const JOB_NAME = 'album-critic-reviews-etl';

/** Required unless DRY_RUN — a dry run reaches zero LLM calls, so it must
 *  validate without one. A real run with no key fails fast at startup. */
export const resolveAnthropicApiKey = (
  dryRun: boolean,
  raw: string | undefined = process.env.ANTHROPIC_API_KEY
): string | null => {
  if (dryRun) return null;
  if (!raw) {
    throw new Error('ANTHROPIC_API_KEY is required for a non-DRY_RUN run (DRY_RUN=true skips every LLM call)');
  }
  return raw;
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    // Fail-fast env resolution before any network or DB touch.
    const dryRun = resolveDryRun();
    const researchDataToken = resolveResearchDataToken();
    const anthropicApiKey = resolveAnthropicApiKey(dryRun);
    log('info', 'init', `${JOB_NAME} initialized`, { dry_run: dryRun, has_anthropic_key: anthropicApiKey !== null });

    const anthropicClient: AnthropicLike | null = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;
    const extract = (item: CorpusItem): Promise<Extraction> => {
      if (!anthropicClient) {
        // Unreachable in practice: runEtl returns before calling extract
        // when dryRun is true, which is the only case anthropicClient is
        // null.
        throw new Error('extract() called without an Anthropic client (DRY_RUN should have short-circuited first)');
      }
      return llmExtract(item, anthropicClient);
    };

    await runEtl({
      fetchManifest: async () => gunzipManifest(await fetchManifestAsset(researchDataToken)),
      matchItem,
      loadExistingPairs,
      extract,
      upsertRow,
      dryRun,
    });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run
// against the mocked DB, mirroring jobs/catalog-popularity-freetext-resolve.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
