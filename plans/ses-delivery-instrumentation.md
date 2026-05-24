# SES delivery latency instrumentation for OTP emails

## Goal

Measure the end-to-end time from `SendEmailCommand` to recipient-MTA acceptance for transactional emails (OTP, password reset, verification, account setup) so we can establish a real `Send → Delivery` p50/p90/p99 distribution by recipient domain. Without this we cannot tell whether the user-reported "slow OTP" is a 2-second tail or a 30-second one, and we cannot tell whether a future deliverability change moved the needle.

Target stated by Jake: p90 `Send → Delivery` < 10 s.

## Non-goals

- This PR does not change any deliverability posture (no DKIM rotation, no MAIL FROM change, no DMARC tightening, no new SES IP pool, no email template changes). Those are downstream changes that we will reason about _after_ we have data.
- This PR does not change anything about how OTPs are generated or how `better-auth` orchestrates the OTP flow. The send is already fire-and-forget; that does not change.
- This PR does not move SES email sending off `console.error`-and-pray for _all_ email types. The targeted change is to swap the OTP catch handler to `Sentry.captureException`, since OTP is the loudest user-visible path. The other three email types (`passwordReset`, `emailVerification`, `accountSetup`) keep their current `console.error` behavior in this PR and can be migrated as a follow-up.

## Diagnostic findings that motivated this approach

Confirmed 2026-05-24 in WXYC AWS account `203767826763`, us-east-1:

| Check                                                             | Result                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `sesv2 get-account.ProductionAccessEnabled`                       | `true`                                                      |
| `EnforcementStatus`                                               | `HEALTHY`                                                   |
| `SendQuota.Max24HourSend` / `MaxSendRate`                         | `50000` / `14/s`                                            |
| `SentLast24Hours`                                                 | `1`                                                         |
| Bounces / Complaints across last ~2 weeks                         | `0` / `0`                                                   |
| `wxyc.org` DKIM                                                   | `SUCCESS`, RSA-2048, signing enabled                        |
| Custom MAIL FROM (`mail.wxyc.org`)                                | `SUCCESS`, SPF aligns                                       |
| `wxyc.org` SPF                                                    | `v=spf1 include:_spf.google.com include:amazonses.com ~all` |
| `_dmarc.wxyc.org`                                                 | `p=none` (monitor)                                          |
| DKIM CNAMEs (×3)                                                  | all resolve to `dkim.amazonses.com`                         |
| Configuration set `my-first-configuration-set` event destinations | **none**                                                    |
| `wxyc.org` identity default config set                            | **`my-first-configuration-set`** (already attached)         |

The deliverability fundamentals are fine. The problem is that we are sending blind: no event publishing, no measurement, no per-message visibility past the `SendEmailCommand` return.

The fact that the `wxyc.org` identity already has `my-first-configuration-set` as its default config set means **adding an EventDestination instantly attributes every existing send** without touching `shared/authentication/src/email.ts`. That is the key lever and the reason this plan is small.

## Architecture

```
SES.SendEmailCommand (from BS auth)
       │
       ▼
AWS SES (us-east-1)  ── publishes Send, Delivery, Bounce, Complaint, Reject, DeliveryDelay events
       │              to Configuration Set's EventDestination
       ▼
SNS topic `ses-delivery-events-prod`  (in WXYC AWS 203767826763, us-east-1)
       │
       ▼ HTTPS subscription
POST https://api.wxyc.org/internal/ses-events  (new endpoint on apps/backend)
       │
       ├─ SubscriptionConfirmation → GET the SubscribeURL (one-time, on subscription create)
       ├─ Signature validation via sns-payload-validator (every message)
       ├─ Parse SES event payload
       └─ Emit Sentry transaction "ses.event" with:
              op:               "email.ses"
              tags:             email.type, email.event_type, recipient.domain
              measurements:     delivery_latency_ms (only set on Delivery events,
                                                     = Delivery.timestamp - mail.timestamp)
              status:           ok | failed_precondition | unavailable
       ▼
Sentry project (BS apps/backend) — trace explorer + metric explorer get the spans
       (no separate dashboard build in this PR; we read from trace explorer
        per the established LML pattern.)
```

### Why SNS HTTPS → BS, not SNS → Lambda → CloudWatch

- BS already runs at `api.wxyc.org` with `/internal/*` open for webhook-style traffic (`tubafrenzy webhook`, `LML streaming-status-webhook`, `flowsheet-sync-notify`). The same auth/validation pattern fits perfectly.
- BS already has `@sentry/node` 10.52.0 instrumented (`apps/backend/instrument.ts`) and a documented "wrap-at-chokepoint + project-onto-span" pattern (LML#213/BS#646). The SES handler slots in cleanly.
- A new Lambda would mean (a) another AWS-managed deploy target, (b) another place to ship code, (c) duplicating Sentry instrumentation. Worth nothing here.
- The traffic is bounded: at current volume (1 send/day) and even at 5,000 sends/day, we are looking at 5–25k SNS POSTs/day; BS handles ~50k routine flowsheet/rotation webhook hits/day without issue.

### Why EventDestination → SNS, not → EventBridge or → CloudWatch directly

- **CloudWatch metrics destination** drops the per-message timestamps and message-ID; we get hourly aggregate counters but cannot compute per-message latency or break down by recipient domain. Rejected.
- **CloudWatch Logs destination via Firehose** works but adds a Firehose stream + S3 bucket + lifecycle policy for no compelling benefit at this volume.
- **EventBridge bus → API Destination → BS** is one extra hop with extra IAM and extra failure modes. SNS → HTTPS is the older, simpler, well-trodden pattern with first-class signature validation. Rejected for now; we can migrate later if we want EventBridge's filtering.

## Components

### A. AWS-side infrastructure (provisioned via AWS CLI under `wxyc-api` profile)

A.1. **SNS topic**: `arn:aws:sns:us-east-1:203767826763:ses-delivery-events-prod`

- Encryption: AWS-managed KMS key (`alias/aws/sns`)
- Access policy: allow `ses.amazonaws.com` from this account to `sns:Publish`. No cross-account; no public publish.

A.2. **SES Configuration Set EventDestination**

- Config set: `my-first-configuration-set` (existing)
- Destination name: `ses-delivery-events-prod-sns`
- Enabled: `true`
- Matching events: `SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY`
- SNS target: the topic above

A.3. **SNS HTTPS subscription**

- Endpoint: `https://api.wxyc.org/internal/ses-events`
- Created **after** the BS endpoint is deployed (so the handler can confirm).
- Confirmation: BS handler GETs `SubscribeURL` on `SubscriptionConfirmation` message receipt; SNS marks the subscription confirmed.

A.4. **Raw message delivery**: **not enabled.** We want SNS's wrapping envelope because it carries the signature we validate against. Raw delivery would bypass validation.

A.5. All three resources will be created via shell commands documented in the PR description so they are reproducible, but they will not be Terraformed in this PR — WXYC has no Terraform repo for SES yet.

### B. Backend-Service changes

All changes are scoped to `apps/backend` and `shared/authentication`.

**Decisions resolved pre-implementation** (from `/review-plan` 2026-05-24):

- **Body parser**: route uses inline `express.text({ type: '*/*', limit: '64kb' })` as a route-level middleware on the POST handler. `apps/backend/app.ts:44`'s `app.use(express.json())` only parses `application/json`, and SNS sends `Content-Type: text/plain`, so the global parser never touches SNS bodies. No "mount before json" gymnastics needed.
- **Sentry in `@wxyc/authentication`**: add `@sentry/node` as a runtime dependency to `shared/authentication/package.json` and to the `external: [...]` list in `shared/authentication/tsup.config.ts` (matching the existing pattern for `drizzle-orm`, `postgres`, `better-auth`, `@wxyc/shared`). This keeps Sentry out of the package's bundled output but installed where consumers use it. `apps/auth` already has `@sentry/node` 10.52.0 and loads `instrument.ts` at process start via `node --import`, so the import in `auth.definition.ts` resolves cleanly at runtime. No factory refactor needed.

B.1. **New file `apps/backend/services/ses-events/sns-validator.ts`**

- Wraps `sns-payload-validator` (or equivalent — see "Dependency choice" below).
- Pure function: `validateSnsMessage(body: unknown): Promise<ValidatedSnsMessage>`
- Throws on signature mismatch, expired cert, wrong topic ARN, or unrecognized message type.
- Topic ARN is read from `SES_EVENTS_SNS_TOPIC_ARN` env var (fail-fast if unset).

B.2. **New file `apps/backend/services/ses-events/parse-ses-event.ts`**

- Given a `ValidatedSnsMessage`, parse the SES event JSON payload (which lives in `Message`).
- Returns a typed `SesEvent`:
  ```ts
  type SesEvent =
    | { kind: 'Send'; messageId: string; sendTimestamp: Date; mailType: WxycMailType | null; recipients: string[] }
    | {
        kind: 'Delivery';
        messageId: string;
        sendTimestamp: Date;
        deliveredAt: Date;
        recipient: string;
        smtpResponse: string;
        processingTimeMillis: number;
        mailType: WxycMailType | null;
      }
    | {
        kind: 'Bounce';
        messageId: string;
        sendTimestamp: Date;
        recipient: string;
        bounceType: string;
        bounceSubType: string;
        mailType: WxycMailType | null;
      }
    | { kind: 'Complaint'; messageId: string; sendTimestamp: Date; recipient: string; mailType: WxycMailType | null }
    | { kind: 'Reject'; messageId: string; sendTimestamp: Date; reason: string; mailType: WxycMailType | null }
    | {
        kind: 'DeliveryDelay';
        messageId: string;
        sendTimestamp: Date;
        recipient: string;
        delayType: string;
        expirationTime: Date | null;
        mailType: WxycMailType | null;
      };
  ```
- `mailType` is inferred from a custom SES message tag we will add to `SendEmailCommand` in a future PR (see "Future work"). In this PR, `mailType` is always `null`; we will tag by subject-line heuristic instead and document the limitation.

B.3. **New file `apps/backend/services/ses-events/emit-span.ts`**

- Given a typed `SesEvent`, emit a Sentry transaction with:
  - `name: 'ses.event'`
  - `op: 'email.ses'`
  - `attributes`:
    - `email.event_type` = `'Send' | 'Delivery' | 'Bounce' | ...`
    - `email.message_id` = SES `mail.messageId`
    - `email.recipient_domain` = the part after `@` in the (first) recipient (do **not** log the local-part — PII)
    - `email.mail_type` = `mailType ?? 'unknown'`
    - `email.smtp_response` = present only on Delivery; trimmed to 500 chars
    - `email.bounce_type` / `email.bounce_subtype` = present only on Bounce
    - `email.delay_type` = present only on DeliveryDelay
  - `measurements`:
    - `ses.delivery_latency_ms` (Delivery only) = `deliveredAt.getTime() - sendTimestamp.getTime()`
    - `ses.processing_time_ms` (Delivery only) = `processingTimeMillis` from the event
  - `status`: `ok` on Send/Delivery, `failed_precondition` on Bounce/Complaint/Reject, `deadline_exceeded` on DeliveryDelay
- Span lifetime is synchronous: we open it, set attributes/measurements, end it. There is no fetch to wrap.

B.4. **New file `apps/backend/routes/ses-events.route.ts`**

- Express `Router`.
- `POST /` (mounted at `/internal/ses-events` from `apps/backend/app.ts`).
- Body-parser config: SNS sends `Content-Type: text/plain` (yes, really — historical AWS choice). The route uses `express.text({ type: '*/*' })` scoped to this router so the raw string is available for signature validation. (The rest of `/internal/*` keeps `express.json()`.)
- Pseudocode:

  ```ts
  router.post('/', express.text({ type: '*/*', limit: '64kb' }), async (req, res) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }

    let validated: ValidatedSnsMessage;
    try {
      validated = await validateSnsMessage(parsed);
    } catch (e) {
      Sentry.captureException(e, { tags: { subsystem: 'ses-events', stage: 'validate' } });
      res.status(400).json({ error: 'invalid signature or topic' });
      return;
    }

    if (validated.Type === 'SubscriptionConfirmation') {
      try {
        await confirmSubscription(validated.SubscribeURL);
      } catch (e) {
        Sentry.captureException(e, { tags: { subsystem: 'ses-events', stage: 'confirm' } });
        res.status(500).json({ error: 'failed to confirm subscription' });
        return;
      }
      res.json({ ok: true, confirmed: true });
      return;
    }

    if (validated.Type === 'UnsubscribeConfirmation') {
      // Log + 200; do nothing else. Operator removed the subscription.
      console.warn('[ses-events] received UnsubscribeConfirmation', { topicArn: validated.TopicArn });
      res.json({ ok: true });
      return;
    }

    if (validated.Type !== 'Notification') {
      res.status(400).json({ error: 'unexpected message type' });
      return;
    }

    let event: SesEvent;
    try {
      event = parseSesEvent(validated);
    } catch (e) {
      Sentry.captureException(e, { tags: { subsystem: 'ses-events', stage: 'parse' } });
      res.status(400).json({ error: 'unparseable ses event' });
      return;
    }

    try {
      emitSpan(event);
    } catch (e) {
      // Observability must never break the receive path.
      console.warn('[ses-events] failed to emit span', e);
    }

    res.json({ ok: true });
  });
  ```

- Auth model: **SNS signature validation is the auth**. We do not require `X-Internal-Key` because SES → SNS → BS cannot inject custom headers. The topic ARN is pinned via `SES_EVENTS_SNS_TOPIC_ARN`, and the signature is verified against AWS's cert chain.

B.5. **Wire the router** in `apps/backend/app.ts`:

- `app.use('/internal/ses-events', sesEventsRoute);`
- Ordering relative to the global `express.json()` is irrelevant — see "Decisions resolved pre-implementation" above. The route's inline `express.text()` middleware claims the body before the handler runs.

B.6. **Change in `shared/authentication/src/auth.definition.ts`** (the only code change outside `apps/backend`):

- Replace the silently-swallowed `console.error('Error sending OTP email:', error)` in the `emailOTP({ sendVerificationOTP })` callback (`shared/authentication/src/auth.definition.ts:320`) with:
  ```ts
  void sendOTPEmail({ to: email, otp, type }).catch((error) => {
    console.error('Error sending OTP email:', error);
    Sentry.captureException(error, { tags: { subsystem: 'auth-otp', email_type: type } });
  });
  ```
- Add `import * as Sentry from '@sentry/node';` at the top of the file.
- Add `@sentry/node` to `shared/authentication/package.json` `dependencies` (same `^10.52.0` as the rest of the repo).
- Add `'@sentry/node'` to the `external: [...]` list in `shared/authentication/tsup.config.ts` (matches the existing pattern for `drizzle-orm`, `postgres`, `better-auth`, `@wxyc/shared`).
- In scope: OTP only, since that is what Jake asked about. The other three callers (`sendResetPassword`, `sendVerificationEmail`, admin account-setup) keep their current `console.error` and are listed in "Future work" below.

### C. Test strategy (TDD)

C.1. **Unit tests** for `parse-ses-event.ts`:

- Fixtures: real SES event payloads pasted from AWS docs for each of the six event types.
- Assert each fixture maps to the right `SesEvent` shape, including correct timestamp parsing (SES uses ISO 8601 with timezone).
- Negative cases: missing `mail.timestamp`, malformed `eventType`, empty `mail.destination`.

C.2. **Unit tests** for `emit-span.ts`:

- Mock `@sentry/node`'s `startSpan` and assert attributes/measurements per event kind.
- Verify recipient local-part is **never** present in any attribute (PII guard).
- Verify `delivery_latency_ms` is non-negative.

C.3. **Unit tests** for the route, modeled on `tests/unit/routes/internal.route.test.ts`:

- Mock `validateSnsMessage` and `emitSpan`.
- Happy-path: SubscriptionConfirmation → triggers `confirmSubscription` mock, returns 200.
- Happy-path: Notification with Send → triggers `emitSpan` mock, returns 200.
- Negative: invalid signature → 400, Sentry captured.
- Negative: wrong topic ARN → 400, Sentry captured (verified via validator throwing).
- Negative: unparseable SES payload → 400, Sentry captured, response does NOT include the raw payload (no log injection).
- Defensive: `emitSpan` throws → handler still 200s (observability must not break the receive path).

C.4. **No integration tests** in this PR. The dependency on AWS SNS for real round-trip is real but out of scope; the unit tests with realistic fixtures + a manual smoke test post-deploy is the right scope.

C.5. **Smoke test plan** (manual, post-deploy, documented in PR body):

- Trigger an OTP via the auth sign-in path against prod.
- Observe `Send` and `Delivery` spans land in Sentry within ~30s.
- Confirm `ses.delivery_latency_ms` measurement is populated.
- Confirm `email.recipient_domain` is the domain only, no local-part.

### D. Configuration / env vars

Adds to `apps/backend/.env.example` and `docs/env-vars.md` under a new **SES delivery events** section:

- `SES_EVENTS_SNS_TOPIC_ARN` — the topic ARN to pin signature validation against.
- (No new AWS creds. The Backend container does not call SES; it only receives the SNS HTTP POST. Signature validation requires no AWS auth — just the public cert from SNS's signing-cert URL.)

If `SES_EVENTS_SNS_TOPIC_ARN` is unset, the route still mounts but every POST returns 400 with `subsystem: 'ses-events', stage: 'validate'` Sentry tags. This is preferable to throwing at startup, since it keeps the deploy alive if the env var is missing.

### E. Dependency choice (resolved)

Audited 2026-05-24 from `npm view`:

| Package                 | Owner                                                   | License    | Last published | Runtime deps                                  |
| ----------------------- | ------------------------------------------------------- | ---------- | -------------- | --------------------------------------------- |
| `sns-validator`         | **AWS (`github.com/aws/aws-js-sns-message-validator`)** | Apache-2.0 | 2025-03-27     | **none**                                      |
| `sns-payload-validator` | community (devinstewart)                                | MIT        | 2023-02-07     | lru-cache                                     |
| `aws-sns-validator`     | community (buithaibinh)                                 | ISC        | 2022-04-12     | request (deprecated), requestretry, lru-cache |

**Decision: `sns-validator`** — AWS-owned, most recently updated, zero runtime dependencies. The API is callback-based (`validator.validate(msg, cb)`); we wrap it in a `Promise` inside `sns-validator.ts` so the route stays `async/await`.

### F. Rollout

1. Land BS PR with the endpoint + tests + `email.ts` Sentry capture.
2. After deploy: run AWS CLI commands to create the SNS topic, attach the EventDestination, create the HTTPS subscription. (One-shot operator steps; documented in PR body.)
3. Wait for `SubscriptionConfirmation` POST → BS auto-confirms → SES starts publishing events.
4. Trigger a test OTP, verify span lands in Sentry within ~30s.
5. Let it bake for 24h, then come back and read p90 from Sentry trace explorer with `op:email.ses email.event_type:Delivery`.

If p90 is already <10s, we close the task and the instrumentation stays in place as ongoing visibility. If p90 is high, we have per-recipient-domain breakdown to drive the next decision (Gmail throttling vs iCloud vs Outlook vs something else).

## Future work (intentionally out of scope)

- Tag `SendEmailCommand` with an `email.mail_type` SES message tag (`sign-in`, `email-verification`, etc.) so spans can be grouped without subject-line heuristics. This is a one-line change in `sendOTPEmail`/`sendEmail` but is deferred to keep this PR focused on the receive side.
- Migrate the other three `void sendEmail(...).catch(...)` callers (`sendResetPassword`, `sendVerificationEmail`, the admin account-setup path) to `Sentry.captureException`.
- Add a Sentry alert on `ses.delivery_latency_ms` p90 > 10s once we know what the baseline is.
- Move the SES Configuration Set + SNS topic into a (yet-to-exist) WXYC Terraform repo when one is created.

## Risk register

| Risk                                                                                             | Likelihood   | Impact | Mitigation                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SNS signature validation library has CVE                                                         | low          | high   | Pin version, audit on first install, dependabot watch                                                                                                             |
| Body-parser ordering breaks other `/internal/*` routes                                           | low          | medium | Scoped `express.text()` to this router only; covered by existing internal-route tests still passing                                                               |
| Subscription confirmation HTTPS GET fails (cert chain)                                           | low          | medium | Confirmation is operator-visible (curl the topic-list endpoint); operator can re-trigger via SNS console                                                          |
| BS endpoint receives spoofed SES events                                                          | low          | high   | Signature validation against AWS cert chain + topic ARN pin                                                                                                       |
| Recipient local-part leaks into Sentry attrs (PII)                                               | medium       | medium | Explicit domain-only extraction + unit test                                                                                                                       |
| Volume of SNS POSTs overwhelms BS                                                                | very low     | low    | At 5k/day target volume, ~3/min — nowhere near BS load                                                                                                            |
| `Sentry.captureException` import in `@wxyc/authentication` breaks the package's standalone build | **resolved** | —      | Add `@sentry/node` to package `dependencies` + tsup `external` list, matching the existing pattern. No factory refactor; runtime resolution works in `apps/auth`. |

## Files changed (rough estimate)

- `apps/backend/routes/ses-events.route.ts` (new, ~70 LOC)
- `apps/backend/services/ses-events/sns-validator.ts` (new, ~30 LOC)
- `apps/backend/services/ses-events/parse-ses-event.ts` (new, ~80 LOC)
- `apps/backend/services/ses-events/emit-span.ts` (new, ~50 LOC)
- `apps/backend/services/ses-events/confirm-subscription.ts` (new, ~15 LOC)
- `apps/backend/app.ts` (~3-line addition)
- `shared/authentication/src/auth.definition.ts` OR `apps/auth/app.ts` (~3-line addition)
- `tests/unit/routes/ses-events.route.test.ts` (new, ~200 LOC)
- `tests/unit/services/ses-events/parse-ses-event.test.ts` (new, ~150 LOC)
- `tests/unit/services/ses-events/emit-span.test.ts` (new, ~120 LOC)
- `apps/backend/.env.example` (1 line)
- `docs/env-vars.md` (small section)
- `apps/backend/package.json` (1 dep)
- `package-lock.json` (regenerated)

Net delta target: ~750 LOC including tests. Well under the 1000-LOC PR ceiling.

## Acceptance criteria

1. `POST /internal/ses-events` with a valid `SubscriptionConfirmation` body confirms the subscription and returns 200.
2. `POST /internal/ses-events` with a valid `Notification` body of each of the six SES event types emits exactly one Sentry span with the correct `email.event_type` attribute.
3. `Delivery`-kind events carry a non-negative `ses.delivery_latency_ms` measurement.
4. No attribute or log line in any code path contains a recipient's email local-part.
5. Signature mismatch, wrong topic ARN, or unparseable payload all return 4xx and emit a `Sentry.captureException` with `subsystem: 'ses-events'`.
6. `sendOTPEmail` failures are captured to Sentry with `subsystem: 'auth-otp'`.
7. All existing internal-route tests still pass (body-parser scoping change is non-breaking).
8. `npm run typecheck && npm run lint && npm run format:check && npm run test:unit && npm run build` all pass locally before push.
