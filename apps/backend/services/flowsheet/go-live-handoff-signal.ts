/**
 * Forensic signal for `POST /flowsheet/join`'s start-vs-join decision.
 *
 * **A takeover leaves no other trace.** `endShow` back-dates the closed show's
 * `end_time` to `resolveShowEndInstant` (`MAX(add_time)` floored at
 * `start_time`), and `wxyc_schema.shows` carries no `updated_at`, so the row
 * records the value and never when it was written. Checked against eight days
 * of production: every candidate signature that would distinguish a takeover
 * from a DJ signing off normally also fires on shows predating the branch.
 *
 * Sentry rather than a CloudWatch counter, because the question is "which
 * handoff", not "how many". A `Count` datum carrying only an outcome says one
 * happened in some minute and leaves you correlating against the archive --
 * which is the exercise that already failed. The event below names both shows
 * and the DJ, and is alertable on its fingerprint.
 *
 * This is the repo's existing shape for a rare event worth alerting on:
 * `services/cdc/dispatcher.ts` wires the BS#1120 fallback sinks to
 * `captureMessage` to satisfy "emit a metric Sentry can alert on", and
 * `flowsheet.service.ts`'s suppressed `dj_join` marker carries `dj_id` +
 * `show_id` the same way. `services/observability/cache-stats.ts` states the
 * stance outright: no separate metrics pipeline, the Sentry surface IS the
 * metric surface.
 *
 * `level: 'info'` -- a handoff is not a fault. The stable `fingerprint` keeps
 * every takeover in one Sentry issue so the count is the issue's event count
 * and an alert can fire on the first occurrence.
 */
import * as Sentry from '@sentry/node';
import type { FlowsheetJoinIntent } from '@wxyc/shared/dtos';

/**
 * What is knowable at the moment the collision is resolved.
 *
 * Deliberately not the resulting show's id. For a join there is no new show,
 * and for a takeover this is recorded between `endShow` and `startShow`, so
 * the new id does not exist yet -- waiting for it would mean recording only on
 * the happy path and dropping the one case worth alerting on. `open_show_id`
 * is the show that was closed or co-hosted, which is the fact the archive
 * cannot evidence afterwards.
 */
export interface GoLiveHandoff {
  open_show_id: number;
  dj_id: string;
}

/**
 * Record one resolved go-live collision.
 *
 * Call only where the write actually happened, and for a takeover call it
 * after `endShow` rather than after `startShow`: `endShow` is the destructive,
 * unrecoverable half. If `startShow` then fails, someone's show has been
 * terminated and that is precisely the case worth knowing about -- recording
 * only on the happy path would drop it.
 */
export function recordGoLiveHandoff(intent: FlowsheetJoinIntent, handoff: GoLiveHandoff): void {
  Sentry.captureMessage(`Go-live handoff: ${intent}`, {
    level: 'info',
    fingerprint: ['go-live-handoff', intent],
    tags: { tool: 'flowsheet', handoff_intent: intent },
    extra: { ...handoff },
  });
}
