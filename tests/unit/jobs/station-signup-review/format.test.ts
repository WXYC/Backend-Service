/**
 * Unit tests for station-signup-review/format.ts -- pure email rendering.
 * No DB, no network, no mocks needed.
 */
import { describe, it, expect } from '@jest/globals';
import {
  buildStationSignupDigestEmail,
  daysPending,
  formatPacificDate,
} from '../../../../jobs/station-signup-review/format';
import type { PendingSignupRow } from '../../../../jobs/station-signup-review/query';

const row = (overrides: Partial<PendingSignupRow> = {}): PendingSignupRow => ({
  userId: 'u1',
  name: 'Test DJ',
  email: 'testdj@example.com',
  djName: 'DJ Test',
  selfSignupAt: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
});

describe('daysPending', () => {
  it('is 0 on the day of signup', () => {
    const now = new Date('2026-07-01T12:00:00Z');
    expect(daysPending(new Date('2026-07-01T00:00:00Z'), now)).toBe(0);
  });

  it('floors partial days', () => {
    const selfSignupAt = new Date('2026-07-01T00:00:00Z');
    const now = new Date('2026-07-05T23:59:00Z');
    expect(daysPending(selfSignupAt, now)).toBe(4);
  });
});

describe('formatPacificDate', () => {
  it('renders the Pacific calendar date for a UTC instant', () => {
    // 2026-07-31 23:00 PDT == 2026-08-01 06:00 UTC
    expect(formatPacificDate(new Date('2026-08-01T06:00:00Z'))).toBe('2026-07-31');
  });
});

describe('buildStationSignupDigestEmail', () => {
  const now = new Date('2026-08-01T15:00:00Z');

  it('returns null when nothing is pending', () => {
    expect(buildStationSignupDigestEmail([], { now, downgraded: [] })).toBeNull();
  });

  it('includes the pending count and no downgrade mention in the subject when nothing was downgraded', () => {
    const digest = buildStationSignupDigestEmail([row()], { now, downgraded: [] });
    expect(digest?.subject).toContain('1 pending');
    expect(digest?.subject).not.toContain('downgraded');
  });

  it('mentions the downgraded count in the subject when accounts were downgraded this run', () => {
    const downgradedRow = row({ userId: 'u2', selfSignupAt: new Date('2026-06-01T00:00:00Z') });
    const digest = buildStationSignupDigestEmail([row(), downgradedRow], { now, downgraded: [downgradedRow] });
    expect(digest?.subject).toContain('2 pending');
    expect(digest?.subject).toContain('1 downgraded');
  });

  it('marks a downgraded account distinctly from one still within the 30-day window, in both text and html', () => {
    const stillPending = row({ userId: 'u1', selfSignupAt: new Date('2026-07-25T00:00:00Z') }); // 7 days
    const downgraded = row({ userId: 'u2', selfSignupAt: new Date('2026-06-01T00:00:00Z') }); // 61 days
    const digest = buildStationSignupDigestEmail([stillPending, downgraded], { now, downgraded: [downgraded] });

    expect(digest?.text).toContain('DOWNGRADED dj -> member today');
    expect(digest?.text).toContain('day(s) until auto-downgrade');
    expect(digest?.html).toContain('downgraded dj -&gt; member today');
  });

  it('marks an account downgraded by a PRIOR run distinctly, without a negative countdown', () => {
    // 75 days pending, well past the 30-day cutoff, but not in this run's `downgraded` list --
    // i.e. a prior run already flipped its role, and it never leaves the pending cohort because
    // the downgrade doesn't set self_signup_reviewed_at.
    const staleDowngrade = row({ userId: 'u3', selfSignupAt: new Date('2026-05-18T00:00:00Z') });
    const digest = buildStationSignupDigestEmail([staleDowngrade], { now, downgraded: [] });

    expect(digest?.text).not.toMatch(/-\d+ day\(s\) until auto-downgrade/);
    expect(digest?.text).toContain('already downgraded — awaiting review');
    expect(digest?.html).toContain('already downgraded — awaiting review');
  });

  it('escapes HTML-significant characters in name/email', () => {
    const malicious = row({ name: '<script>alert(1)</script>', djName: null, email: 'a&b@example.com' });
    const digest = buildStationSignupDigestEmail([malicious], { now, downgraded: [] });

    expect(digest?.html).not.toContain('<script>');
    expect(digest?.html).toContain('&lt;script&gt;');
    expect(digest?.html).toContain('a&amp;b@example.com');
  });

  it('falls back to name when djName is null', () => {
    const noDjName = row({ djName: null, name: 'Real Name' });
    const digest = buildStationSignupDigestEmail([noDjName], { now, downgraded: [] });
    expect(digest?.text).toContain('Real Name');
  });

  it('sorts pending accounts oldest-first', () => {
    const newer = row({ userId: 'newer', name: 'Newer', djName: null, selfSignupAt: new Date('2026-07-30T00:00:00Z') });
    const older = row({ userId: 'older', name: 'Older', djName: null, selfSignupAt: new Date('2026-06-01T00:00:00Z') });
    const digest = buildStationSignupDigestEmail([newer, older], { now, downgraded: [] });

    expect(digest?.text.indexOf('Older')).toBeLessThan(digest?.text.indexOf('Newer') ?? -1);
  });
});
