/**
 * Concurrency + rate gate for the BS#2000 remediation's LML calls.
 *
 * Reuses the shared `BACKFILL_LML_*` family (documented in `docs/env-vars.md`)
 * rather than minting a private prefix, so the whole offline-drain family is
 * tunable from one knob and inherits its standing pre-flight rule: verify the
 * sibling cron containers are Exited before running, because they share LML's
 * Discogs budget.
 *
 * Sem(1) + TokenBucket(20/min) by default. Note the BS#1995 unit mismatch: the
 * bucket counts LML *lookups*, not the Discogs calls each fans out into
 * (~2.5x measured on prod), so the effective egress at the default is ~30/min
 * — do not read LML's 50/min Discogs ceiling as headroom to raise this to 50.
 *
 * A job-owned limiter deliberately passes neither `breaker` nor `queueWaitMs`,
 * so it keeps the unbounded shape (per CLAUDE.md) and never sheds. That is why
 * `verdict.ts`'s shed arm is a forward-compat pin rather than a live path.
 */

import { type LmlLimiter, Semaphore, TokenBucket, createLmlLimiter as createSharedLmlLimiter } from '@wxyc/lml-client';
import { envInt } from './env.js';

export { type LmlLimiter, Semaphore, TokenBucket };

export const createLmlLimiter = (config?: { maxConcurrent?: number; ratePerMinute?: number }): LmlLimiter =>
  createSharedLmlLimiter({
    maxConcurrent: config?.maxConcurrent ?? envInt('BACKFILL_LML_MAX_CONCURRENT', 1, 'lml-limiter'),
    ratePerMinute: config?.ratePerMinute ?? envInt('BACKFILL_LML_RATE_PER_MIN', 20, 'lml-limiter'),
  });

export const defaultLmlLimiter: LmlLimiter = createLmlLimiter();
