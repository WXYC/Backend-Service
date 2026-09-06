/**
 * Unit tests for station-signup-review/format.ts -- pure email rendering.
 * No DB, no network, no mocks needed.
 *
 * The core of this file is the status vocabulary: the digest must say
 * something TRUE about every pending account, for each of the six outcomes
 * `downgrade.ts` can produce. The version this replaced inferred "already
 * downgraded — awaiting review" from `days >= 30` alone, which was an
 * outright false statement whenever the kill switch was off or the on-air
 * guard deferred.
 */
import { describe, it, expect } from '@jest/globals';
import {
  RECIPIENT_FALLBACK_NOTICE,
  buildStationSignupDigestEmail,
  daysPending,
  formatPacificDate,
  statusText,
} from '../../../../jobs/station-signup-review/format';
import type { DowngradeDecision } from '../../../../jobs/station-signup-review/downgrade';
import type { PendingSignupRow } from '../../../../jobs/station-signup-review/query';

const row = (overrides: Partial<PendingSignupRow> = {}): PendingSignupRow => ({
  userId: 'u1',
  name: 'Test DJ',
  email: 'testdj@example.com',
  djName: 'DJ Test',
  selfSignupAt: new Date('2026-07-01T00:00:00Z'),
  selfSignupDowngradedAt: null,
  ...overrides,
});

const decision = (overrides: Partial<DowngradeDecision> = {}): DowngradeDecision => ({
  row: row(),
  status: 'pending',
  downgradedAt: null,
  ...overrides,
});

const NOW = new Date('2026-08-01T15:00:00Z');

describe('daysPending', () => {
  it('is 0 on the day of signup', () => {
    expect(daysPending(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T12:00:00Z'))).toBe(0);
  });

  it('floors partial days', () => {
    expect(daysPending(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-05T23:59:00Z'))).toBe(4);
  });
});

describe('formatPacificDate', () => {
  it('renders the Pacific calendar date for a UTC instant', () => {
    // 2026-07-31 23:00 PDT == 2026-08-01 06:00 UTC
    expect(formatPacificDate(new Date('2026-08-01T06:00:00Z'))).toBe('2026-07-31');
  });
});

describe('statusText', () => {
  it('names the date for a downgrade this run, and emphasizes it', () => {
    const result = statusText(decision({ status: 'downgraded', downgradedAt: NOW }), NOW);
    expect(result.text).toBe('downgraded dj -> member on 2026-08-01');
    expect(result.emphasize).toBe(true);
  });

  it('names the ORIGINAL date for a prior-run downgrade, not today, and does not emphasize it', () => {
    const marker = new Date('2026-07-04T20:00:00Z');
    const result = statusText(decision({ status: 'already-downgraded', downgradedAt: marker }), NOW);
    expect(result.text).toBe('downgraded dj -> member on 2026-07-04 — still awaiting review');
    expect(result.emphasize).toBe(false);
  });

  it('says "deferred: on air" for an overdue DJ holding an open show', () => {
    const result = statusText(decision({ status: 'deferred-on-air', deferReason: 'open-show' }), NOW);
    expect(result.text).toBe('overdue — downgrade deferred: on air with an open show');
  });

  it('distinguishes a guard-query failure from an actual open show', () => {
    const result = statusText(decision({ status: 'deferred-on-air', deferReason: 'guard-error' }), NOW);
    expect(result.text).toBe('overdue — downgrade deferred: could not check whether this DJ is on air');
  });

  it('names the kill switch when the account is overdue but the downgrade is disabled', () => {
    const result = statusText(decision({ status: 'downgrade-disabled' }), NOW);
    expect(result.text).toContain('STATION_SIGNUP_DOWNGRADE_ENABLED');
    expect(result.text).toContain('overdue');
  });

  it('says nothing to downgrade for an overdue account that is no longer a dj', () => {
    expect(statusText(decision({ status: 'already-member' }), NOW).text).toBe(
      'overdue — already not a dj; nothing to downgrade'
    );
  });

  it('counts down for an account inside the window', () => {
    const inWindow = decision({ row: row({ selfSignupAt: new Date('2026-07-25T00:00:00Z') }) }); // 7 days
    expect(statusText(inWindow, NOW).text).toBe('23 day(s) until auto-downgrade');
  });

  it.each([
    ['already-downgraded', new Date('2026-05-18T00:00:00Z')],
    ['deferred-on-air', null],
    ['downgrade-disabled', null],
    ['already-member', null],
  ] as const)('never renders a negative countdown for the overdue status %s', (status, downgradedAt) => {
    // 75 days pending, well past the cutoff. `DOWNGRADE_AFTER_DAYS - days`
    // would be -45 for every one of these.
    const stale = decision({
      row: row({ selfSignupAt: new Date('2026-05-18T00:00:00Z') }),
      status,
      downgradedAt,
    });
    expect(statusText(stale, NOW).text).not.toMatch(/-\d+ day\(s\)/);
  });
});

describe('buildStationSignupDigestEmail', () => {
  it('returns null when nothing is pending', () => {
    expect(buildStationSignupDigestEmail([], { now: NOW })).toBeNull();
  });

  it('includes the pending count and no downgrade mention in the subject when nothing is downgrading', () => {
    const digest = buildStationSignupDigestEmail([decision()], { now: NOW });
    expect(digest?.subject).toContain('1 pending');
    expect(digest?.subject).not.toContain('downgrading');
  });

  it('counts the accounts downgrading TODAY in the subject, not every overdue account', () => {
    const digest = buildStationSignupDigestEmail(
      [
        decision(),
        decision({ row: row({ userId: 'u2' }), status: 'downgraded', downgradedAt: NOW }),
        // Overdue but disabled — must NOT inflate the count.
        decision({ row: row({ userId: 'u3' }), status: 'downgrade-disabled' }),
      ],
      { now: NOW }
    );
    expect(digest?.subject).toContain('3 pending');
    expect(digest?.subject).toContain('1 downgrading');
  });

  it('emphasizes only the same-run downgrade in the HTML body', () => {
    const digest = buildStationSignupDigestEmail(
      [
        decision({ row: row({ userId: 'u1' }), status: 'downgraded', downgradedAt: NOW }),
        decision({ row: row({ userId: 'u2' }), status: 'downgrade-disabled' }),
      ],
      { now: NOW }
    );
    expect(digest?.html).toContain('<strong>downgraded dj -&gt; member on 2026-08-01</strong>');
    expect(digest?.html).not.toContain('<strong>overdue');
  });

  it('escapes the status line for HTML, so `->` never lands raw in the body', () => {
    const digest = buildStationSignupDigestEmail([decision({ status: 'downgraded', downgradedAt: NOW })], {
      now: NOW,
    });
    expect(digest?.html).not.toContain('dj -> member');
    expect(digest?.text).toContain('dj -> member');
  });

  it('says nothing about a recipient fallback when STATION_SIGNUP_ALERT_EMAIL is configured', () => {
    const digest = buildStationSignupDigestEmail([decision()], { now: NOW });
    expect(digest?.text).not.toContain(RECIPIENT_FALLBACK_NOTICE);
    expect(digest?.html).not.toContain(RECIPIENT_FALLBACK_NOTICE);
  });

  it('announces the recipient fallback in the body, in both text and html', () => {
    // The fallback is deliberate — an unset var must not kill the safety-net
    // digest — but it must not become the silent permanent configuration.
    const digest = buildStationSignupDigestEmail([decision()], { now: NOW, recipientFallbackInUse: true });
    expect(digest?.text).toContain(RECIPIENT_FALLBACK_NOTICE);
    expect(digest?.html).toContain(RECIPIENT_FALLBACK_NOTICE);
  });

  it('escapes HTML-significant characters in name/email', () => {
    const malicious = decision({
      row: row({ name: '<script>alert(1)</script>', djName: null, email: 'a&b@example.com' }),
    });
    const digest = buildStationSignupDigestEmail([malicious], { now: NOW });

    expect(digest?.html).not.toContain('<script>');
    expect(digest?.html).toContain('&lt;script&gt;');
    expect(digest?.html).toContain('a&amp;b@example.com');
  });

  it('falls back to name when djName is null', () => {
    const digest = buildStationSignupDigestEmail([decision({ row: row({ djName: null, name: 'Real Name' }) })], {
      now: NOW,
    });
    expect(digest?.text).toContain('Real Name');
  });

  it('sorts pending accounts oldest-first', () => {
    const newer = decision({
      row: row({ userId: 'newer', name: 'Newer', djName: null, selfSignupAt: new Date('2026-07-30T00:00:00Z') }),
    });
    const older = decision({
      row: row({ userId: 'older', name: 'Older', djName: null, selfSignupAt: new Date('2026-06-01T00:00:00Z') }),
      status: 'downgrade-disabled',
    });
    const digest = buildStationSignupDigestEmail([newer, older], { now: NOW });

    expect(digest?.text.indexOf('Older')).toBeLessThan(digest?.text.indexOf('Newer') ?? -1);
  });
});
