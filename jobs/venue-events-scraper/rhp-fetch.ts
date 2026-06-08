/**
 * IO wrappers for fetching RHP venue HTML. Pure parsing is in `parse.ts`.
 *
 * Conventions:
 *   - Always send a descriptive User-Agent. Anonymous scrapes are the
 *     fastest way to get rate-limited by a partner venue; "WXYCEventsBot
 *     (+contact)" lets the venue ops team reach out if anything looks
 *     off rather than blocking outright.
 *   - 15s per-request timeout via AbortSignal. Most pages return in
 *     under a second; anything past 15s is almost always a problem.
 *   - One retry on transient failures (timeout / 5xx). No retry on 4xx —
 *     the URL is wrong, retrying doesn't help.
 *   - Concurrency cap on the per-event fetch handled by the orchestrator
 *     (`mapConcurrent`) so this module stays single-request shaped and
 *     easy to unit-test.
 */

import { captureError, log } from './logger.js';

const USER_AGENT = 'WXYCEventsBot/1.0 (+https://wxyc.org/about; contact@wxyc.org)';
const REQUEST_TIMEOUT_MS = 15_000;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string | null
  ) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'HttpError';
  }
}

/**
 * GET a URL with a polite UA + per-request timeout. Throws HttpError on
 * non-2xx. Retries once on AbortError or 5xx; never retries on 4xx.
 */
export const fetchHtml = async (url: string, attempt = 0): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => null);
      if (res.status >= 500 && attempt === 0) {
        return fetchHtml(url, attempt + 1);
      }
      throw new HttpError(res.status, url, body);
    }
    return await res.text();
  } catch (err) {
    if ((err as Error).name === 'AbortError' && attempt === 0) {
      return fetchHtml(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Per-task concurrency runner that doesn't barrel-drop unhandled errors
 * — failed tasks resolve to `null` so the caller can `.filter(Boolean)`
 * and continue.
 *
 * The orchestrator's `processOneEvent` catches each pipeline step and
 * returns a tagged result, so under normal operation the worker's `fn`
 * never throws. The catch below is the safety net for *unexpected*
 * exceptions (programmer error, a future refactor that drops a try, etc.) —
 * we log + Sentry-capture them rather than silently swallowing so a real
 * defect surfaces in the dashboards instead of disappearing.
 */
export const mapConcurrent = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<(R | null)[]> => {
  const out: (R | null)[] = new Array<R | null>(items.length).fill(null);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]);
      } catch (error) {
        // Unexpected: `fn` (processOneEvent) is supposed to handle its own
        // errors. If we land here, something went wrong outside the
        // pipeline's known paths — surface it loudly so it doesn't get
        // lost to the null filter in the caller.
        log('error', 'unexpected_worker_error', `unexpected exception in mapConcurrent worker`, {
          item_index: idx,
          error_message: (error as Error).message,
        });
        captureError(error, 'unexpected_worker_error', { item_index: idx });
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
};

export { HttpError };
