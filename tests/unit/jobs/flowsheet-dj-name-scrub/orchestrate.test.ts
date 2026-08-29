/**
 * Unit tests for jobs/flowsheet-dj-name-scrub/orchestrate.ts (BS#2281).
 *
 * The decision core (`decideDjName`, `buildPiiNameIndex`, `rewriteMessage`)
 * is pure, so it is tested directly rather than through the db mock chain;
 * `runScrub`'s control flow is exercised through its injectable seams
 * (loadPageFn / writeBatchFn / analyzeFn / checkLiveActivity), mirroring
 * tests/unit/jobs/flowsheet-ghost-row-sweep and .../flowsheet-april-gap-import.
 *
 * The scoping tests below are the load-bearing ones. This job writes to the
 * live on-air table under a PII mandate, and its three most dangerous
 * failure modes are all mis-scoping rather than mis-computation:
 *
 *   1. Recomputing `talkset` / `breakpoint` / `message` — rows that are
 *      deliberately NULL — INVENTS a DJ name on a row that never had one.
 *   2. Recomputing `dj_join` / `dj_leave` from the shows join overwrites a
 *      correct guest handle with the primary DJ's name, and leaves `dj_name`
 *      contradicting the `message` on the same row.
 *   3. Applying `startShow`'s no-legacy-fallback chain to the LEGACY
 *      `show_start` cohort nulls every one of them — the exact regression
 *      BS#2068 fixed on `show_end` three weeks ago.
 */

import { resolveShowDjName } from '@wxyc/database';
import {
  decideDjName,
  buildPiiNameIndex,
  classifyChange,
  EXCLUDED_ENTRY_TYPES,
  RECOMPUTED_ENTRY_TYPES,
  PII_NULL_ONLY_ENTRY_TYPES,
  rewriteMessage,
  type ScrubRow,
} from '../../../../jobs/flowsheet-dj-name-scrub/orchestrate';

/** A row whose show has a linked user account with a usable handle. */
const makeRow = (overrides: Partial<ScrubRow> = {}): ScrubRow => ({
  id: 100,
  entry_type: 'track',
  dj_name: 'zorp',
  message: null,
  show_id: 500,
  dj_name_override: null,
  legacy_dj_name: null,
  primary_dj_id: 'user-1',
  user_found: true,
  user_dj_name: 'zorp',
  ...overrides,
});

/** No real names in the index unless a test supplies them. */
const NO_PII = new Set<string>();

describe('entry-type scoping', () => {
  it('partitions every enum member into exactly one pass', () => {
    const all = [...RECOMPUTED_ENTRY_TYPES, ...PII_NULL_ONLY_ENTRY_TYPES, ...EXCLUDED_ENTRY_TYPES].sort();
    expect(all).toEqual(
      ['breakpoint', 'dj_join', 'dj_leave', 'message', 'show_end', 'show_start', 'talkset', 'track'].sort()
    );
    expect(new Set(all).size).toBe(all.length);
  });

  // Failure mode 1: a bare `IS DISTINCT FROM <shows chain>` would make every
  // one of these a candidate and POPULATE it — a PII scrub that invents DJ
  // names on rows that never had one.
  it.each(['talkset', 'breakpoint', 'message'] as const)(
    'never writes to a %s row, even when the shows chain would resolve a name',
    (entry_type) => {
      const row = makeRow({ entry_type, dj_name: null, user_dj_name: 'zorp' });
      expect(decideDjName(row, NO_PII)).toEqual({ action: 'skip', reason: 'entry_type_excluded' });
    }
  );

  it('never writes to an excluded row even when it already holds a real name', () => {
    const row = makeRow({ entry_type: 'talkset', dj_name: 'A. Hearst' });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({
      action: 'skip',
      reason: 'entry_type_excluded',
    });
  });
});

describe('track / show_end — recomputed via the canonical shows chain', () => {
  it.each(['track', 'show_end'] as const)('recomputes %s from resolveShowDjName', (entry_type) => {
    const row = makeRow({ entry_type, dj_name: 'A. Hearst', user_dj_name: 'zorp' });
    const decision = decideDjName(row, NO_PII);
    expect(decision).toEqual({ action: 'write', djName: 'zorp', reason: 'recomputed' });
    // Parity by construction: the expected value IS the canonical helper's.
    expect(decision).toMatchObject({
      djName: resolveShowDjName({
        dj_name_override: row.dj_name_override,
        legacy_dj_name: row.legacy_dj_name,
        primary_dj_id: row.primary_dj_id,
        user: { djName: row.user_dj_name },
      }),
    });
  });

  it('prefers the per-show override over the linked handle (BS#1321)', () => {
    const row = makeRow({ dj_name_override: '  DJ Override  ', user_dj_name: 'zorp' });
    expect(decideDjName(row, NO_PII)).toEqual({ action: 'write', djName: 'DJ Override', reason: 'recomputed' });
  });

  it('falls back to the legacy handle when the linked handle is unusable', () => {
    const row = makeRow({ dj_name: 'A. Hearst', user_dj_name: 'Anonymous', legacy_dj_name: '  legacy handle  ' });
    // TRIMMED on this arm — the user row exists but its handle is unusable.
    expect(decideDjName(row, NO_PII)).toEqual({ action: 'write', djName: 'legacy handle', reason: 'recomputed' });
  });

  it('preserves the UNTRIMMED legacy handle when the show has no linked user', () => {
    // The deliberate asymmetry in resolveShowDjName: `primary_dj_id IS NULL`
    // returns `legacy_dj_name` as-is so a refactor cannot change a byte on
    // the existing wire. The scrub must not "tidy" it.
    const row = makeRow({ primary_dj_id: null, user_found: false, user_dj_name: null, legacy_dj_name: '  legacy  ' });
    expect(decideDjName(row, NO_PII)).toEqual({ action: 'write', djName: '  legacy  ', reason: 'recomputed' });
  });

  it('skips a row whose stored value already equals the recomputed value', () => {
    // Idempotency comes from IS DISTINCT FROM the recomputed value, never
    // from IS NULL — the defect that left BS#1393 under-remediated.
    const row = makeRow({ dj_name: 'zorp', user_dj_name: 'zorp' });
    expect(decideDjName(row, NO_PII)).toEqual({ action: 'skip', reason: 'already_current' });
  });

  it('OVERWRITES a non-NULL polluted value rather than only filling NULLs', () => {
    const row = makeRow({ dj_name: 'A. Hearst', user_dj_name: 'zorp' });
    expect(decideDjName(row, NO_PII)).toMatchObject({ action: 'write', djName: 'zorp' });
  });

  it('writes NULL when the chain resolves to nothing', () => {
    const row = makeRow({ dj_name: 'A. Hearst', user_dj_name: null, legacy_dj_name: null });
    expect(decideDjName(row, NO_PII)).toEqual({ action: 'write', djName: null, reason: 'recomputed' });
  });
});

describe('show_start — split by primary_dj_id provenance', () => {
  it("uses startShow's no-legacy-fallback chain when primary_dj_id is present", () => {
    // startShow: `effective_override ?? resolveDjDisplayName(dj_info.djName)`.
    // legacy_dj_name is NOT an input, so a live show with an unusable handle
    // resolves null even though legacy_dj_name is set.
    const row = makeRow({
      entry_type: 'show_start',
      dj_name: 'A. Hearst',
      user_dj_name: null,
      legacy_dj_name: 'legacy',
    });
    expect(decideDjName(row, NO_PII)).toEqual({ action: 'write', djName: null, reason: 'recomputed_show_start_live' });
  });

  it('honours the override on the live show_start arm', () => {
    const row = makeRow({
      entry_type: 'show_start',
      dj_name: 'A. Hearst',
      dj_name_override: 'Override',
      user_dj_name: null,
    });
    expect(decideDjName(row, NO_PII)).toMatchObject({ action: 'write', djName: 'Override' });
  });

  // Failure mode 3, stated as its own test: the BS#2068 regression.
  it('does NOT null the legacy cohort — the BS#2068 regression', () => {
    const row = makeRow({
      entry_type: 'show_start',
      dj_name: 'legacy handle',
      primary_dj_id: null,
      user_found: false,
      user_dj_name: null,
      legacy_dj_name: 'legacy handle',
    });
    const decision = decideDjName(row, NO_PII);
    expect(decision).not.toMatchObject({ djName: null });
    expect(decision).toEqual({ action: 'skip', reason: 'already_current' });
  });

  it('recomputes a polluted legacy show_start to the legacy handle, not NULL', () => {
    const row = makeRow({
      entry_type: 'show_start',
      dj_name: 'A. Hearst',
      primary_dj_id: null,
      user_found: false,
      user_dj_name: null,
      legacy_dj_name: 'legacy handle',
    });
    expect(decideDjName(row, NO_PII)).toEqual({
      action: 'write',
      djName: 'legacy handle',
      reason: 'recomputed_show_start_legacy',
    });
  });
});

describe('dj_join / dj_leave — PII-null only, never re-attributed', () => {
  // Failure mode 2: the joining guest is not recoverable from `shows`, so a
  // shows-join recompute writes the PRIMARY DJ's name over a correct guest
  // handle and leaves dj_name contradicting the row's own message text.
  it.each(['dj_join', 'dj_leave'] as const)(
    'leaves a %s guest handle alone rather than recomputing it from the shows join',
    (entry_type) => {
      const row = makeRow({ entry_type, dj_name: 'guest handle', user_dj_name: 'primary handle' });
      expect(decideDjName(row, NO_PII)).toEqual({ action: 'skip', reason: 'not_pii' });
    }
  );

  it.each(['dj_join', 'dj_leave'] as const)('nulls a %s row holding a real name', (entry_type) => {
    const row = makeRow({ entry_type, dj_name: 'A. Hearst', user_dj_name: 'primary handle' });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({ action: 'write', djName: null, reason: 'pii_nulled' });
  });

  it('matches the index on the trimmed value, covering both stored forms', () => {
    // The TypeScript writers stored trim(auth_user.name); the SQL COALESCE
    // writers stored it untrimmed. Both must be caught.
    const row = makeRow({ entry_type: 'dj_join', dj_name: '  A. Hearst  ' });
    expect(decideDjName(row, new Set(['A. Hearst']))).toMatchObject({ action: 'write', djName: null });
  });

  it('skips a dj_join row whose dj_name is already NULL', () => {
    const row = makeRow({ entry_type: 'dj_join', dj_name: null });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({ action: 'skip', reason: 'not_pii' });
  });
});

describe('buildPiiNameIndex', () => {
  it('indexes the real name of a user whose handle differs from it', () => {
    const index = buildPiiNameIndex([{ realName: 'A. Hearst', djName: 'zorp' }]);
    expect(index.has('A. Hearst')).toBe(true);
  });

  it('indexes the real name of a user with no handle at all — the Cohort A shape', () => {
    const index = buildPiiNameIndex([{ realName: 'A. Hearst', djName: null }]);
    expect(index.has('A. Hearst')).toBe(true);
  });

  it('indexes the real name of a user whose handle is the literal Anonymous', () => {
    // resolveDjDisplayName nulls 'Anonymous', so the stored snapshot fell
    // through to auth_user.name for these users too.
    const index = buildPiiNameIndex([{ realName: 'A. Hearst', djName: 'Anonymous' }]);
    expect(index.has('A. Hearst')).toBe(true);
  });

  it('EXEMPTS a DJ whose on-air handle legitimately is their real name', () => {
    // Without the exemption this guard trips permanently for that DJ, and
    // the scrub would erase a handle they chose.
    const index = buildPiiNameIndex([{ realName: 'Mickey Mouse', djName: 'Mickey Mouse' }]);
    expect(index.has('Mickey Mouse')).toBe(false);
  });

  it('compares on the trimmed forms so whitespace variance cannot defeat the exemption', () => {
    const index = buildPiiNameIndex([{ realName: '  Mickey Mouse  ', djName: 'Mickey Mouse' }]);
    expect(index.has('Mickey Mouse')).toBe(false);
  });

  // BS#2281 review: the index MUST be keyed on the legal-name column. Reading
  // the public-safe `auth_user.name` was correct until `jobs/auth-user-name-backfill`
  // rewrote every production row to handle-else-username on 2026-08-28
  // (docs/pii.md). This fixture is that post-backfill shape: a DJ with no
  // handle, whose `name` is now their USERNAME and whose legal name lives only
  // in `real_name`. An index built from `name` would index 'ahearst89' (nulling
  // any dj_name that merely matched a username) and MISS 'A. Hearst' entirely —
  // failing in both directions at once, and reporting a clean run either way.
  it('keys on the legal name, not the post-backfill display name', () => {
    const index = buildPiiNameIndex([{ realName: 'A. Hearst', djName: null }]);
    expect(index.has('A. Hearst')).toBe(true);
    expect(index.has('ahearst89')).toBe(false);
  });

  it('ignores users with a blank real name', () => {
    const index = buildPiiNameIndex([{ realName: '   ', djName: 'zorp' }]);
    expect(index.size).toBe(0);
  });
});

describe('orphan rows (show_id IS NULL)', () => {
  // `flowsheet` has no user FK — only `show_id` — so with `show_id IS NULL`
  // there is no shows chain to recompute from and no "that user" to compare
  // against. PII removal is still possible, and is the whole point.
  it('nulls an orphan track row holding a real name', () => {
    const row = makeRow({ show_id: null, dj_name: 'A. Hearst', primary_dj_id: null, user_found: false });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({
      action: 'write',
      djName: null,
      reason: 'pii_nulled',
    });
  });

  it('leaves an orphan row holding a genuine handle alone', () => {
    const row = makeRow({ show_id: null, dj_name: 'zorp', primary_dj_id: null, user_found: false });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({ action: 'skip', reason: 'not_pii' });
  });

  it('never invents a name on an orphan row that has none', () => {
    const row = makeRow({ show_id: null, dj_name: null, primary_dj_id: null, user_found: false });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({ action: 'skip', reason: 'not_pii' });
  });

  it('still refuses to touch an excluded entry type when it is orphaned', () => {
    const row = makeRow({ show_id: null, entry_type: 'talkset', dj_name: 'A. Hearst' });
    expect(decideDjName(row, new Set(['A. Hearst']))).toEqual({
      action: 'skip',
      reason: 'entry_type_excluded',
    });
  });
});

describe('rewriteMessage', () => {
  const PII = new Set(['A. Hearst']);

  it('degrades a show_start message to wording startShow itself emits', () => {
    const decision = rewriteMessage(
      'show_start',
      'Start of Show: A. Hearst joined the set at 6/8/2026, 9:05:52 PM',
      PII
    );
    expect(decision).toEqual({ action: 'write', message: 'Start of show: 6/8/2026, 9:05:52 PM' });
  });

  it('degrades a show_end message to wording endShow itself emits', () => {
    const decision = rewriteMessage('show_end', 'End of Show: A. Hearst left the set at 6/8/2026, 11:58:02 PM', PII);
    expect(decision).toEqual({ action: 'write', message: 'End of show: 6/8/2026, 11:58:02 PM' });
  });

  // The degraded forms for these two must be BYTE-IDENTICAL to what the
  // writers emit on the unresolvable-name path, or the scrub introduces a new
  // message shape into the corpus for entry types that already have one.
  it.each([
    ['show_start', 'Start of Show: A. Hearst joined the set at 6/8/2026, 9:05:52 PM', 'Start of show: '],
    ['show_end', 'End of Show: A. Hearst left the set at 6/8/2026, 9:05:52 PM', 'End of show: '],
  ] as const)('introduces no new message shape for %s', (entryType, stored, writerPrefix) => {
    const decision = rewriteMessage(entryType, stored, PII);
    expect(decision).toMatchObject({ action: 'write' });
    if (decision.action !== 'write') throw new Error('unreachable');
    // `${prefix}${now}` is exactly the writer's degraded template.
    expect(decision.message.startsWith(writerPrefix)).toBe(true);
    expect(decision.message).toMatch(/^[A-Z][a-z]+ of show: \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s(?:AM|PM)$/);
  });

  // Recorded deliberately: these two writers SUPPRESS the row rather than
  // degrade it, so they have no existing nameless form and any rewrite is a
  // new shape in the stored corpus. It matches what WXYC/website's
  // `describeNonTrackEntry` already renders for a null dj_name; the iOS and
  // Android clients were not checked.
  it('introduces a NEW corpus shape for dj_join', () => {
    expect(rewriteMessage('dj_join', 'A. Hearst joined the set!', PII)).toEqual({
      action: 'write',
      message: 'DJ joined the set!',
    });
  });

  it('introduces a NEW corpus shape for dj_leave', () => {
    expect(rewriteMessage('dj_leave', 'A. Hearst left the set!', PII)).toEqual({
      action: 'write',
      message: 'DJ left the set!',
    });
  });

  it('matches the U+202F narrow no-break space newer ICU emits before AM/PM', () => {
    const stored = 'Start of Show: A. Hearst joined the set at 6/8/2026, 9:05:52 PM';
    expect(rewriteMessage('show_start', stored, PII)).toEqual({
      action: 'write',
      message: 'Start of show: 6/8/2026, 9:05:52 PM',
    });
  });

  it('leaves a message whose embedded name is a genuine handle', () => {
    const stored = 'Start of Show: zorp joined the set at 6/8/2026, 9:05:52 PM';
    expect(rewriteMessage('show_start', stored, PII)).toEqual({ action: 'skip', reason: 'not_pii' });
  });

  it('leaves a message that does not match a known template rather than guessing', () => {
    // Legacy tubafrenzy-sourced marker text has its own shapes. Guessing at
    // them is how a scrub mangles prose it does not understand.
    expect(rewriteMessage('show_start', 'DJ A. Hearst is on the air', PII)).toEqual({
      action: 'skip',
      reason: 'no_template_match',
    });
  });

  it('leaves an already-degraded message alone', () => {
    expect(rewriteMessage('show_start', 'Start of show: 6/8/2026, 9:05:52 PM', PII)).toEqual({
      action: 'skip',
      reason: 'no_template_match',
    });
  });

  it('skips a null message', () => {
    expect(rewriteMessage('show_start', null, PII)).toEqual({ action: 'skip', reason: 'no_message' });
  });

  it.each(['track', 'talkset', 'breakpoint', 'message'] as const)(
    'has no template for %s and never rewrites it',
    (entryType) => {
      expect(rewriteMessage(entryType, 'A. Hearst joined the set!', PII)).toEqual({
        action: 'skip',
        reason: 'entry_type_has_no_template',
      });
    }
  );

  it('does not let a name containing the separator text shift the capture', () => {
    // The timestamp tail is matched strictly, so the greedy name capture
    // cannot swallow it.
    const stored = 'Start of Show: joined the set at joined the set at 6/8/2026, 9:05:52 PM';
    const decision = rewriteMessage('show_start', stored, new Set(['joined the set at']));
    expect(decision).toEqual({ action: 'write', message: 'Start of show: 6/8/2026, 9:05:52 PM' });
  });
});

describe('classifyChange — provenance for a would-be write', () => {
  // The prod dry run reported 1,826,070 track rows differing from the
  // canonical value: 86.7% of everything scanned. That number is consistent
  // with cohort B (BS#1393 rewrote `shows.legacy_dj_name` from DJ_NAME to
  // DJ_HANDLE and never re-resolved the track rows), but "consistent with" is
  // not evidence. This classifier turns the aggregate into provenance, so an
  // operator can see how much of it is genuine real-name removal versus
  // cosmetic churn BEFORE 1.8M rows are rewritten on the live on-air table.
  //
  // Diagnostic only — it changes no decision and gates no write.
  const PII = new Set(['Realname Alpha']);
  const row = (djName: string | null, legacyDjName: string | null = null) => ({
    dj_name: djName,
    legacy_dj_name: legacyDjName,
  });

  it('flags a stored roster real name as the confirmed-PII case', () => {
    expect(classifyChange(row('Realname Alpha'), 'zorp', PII)).toBe('stored_is_roster_real_name');
  });

  it('matches the roster on the trimmed stored value, covering both writer families', () => {
    // The TypeScript writers stored trim(auth_user.name); the SQL COALESCE
    // writers stored it untrimmed.
    expect(classifyChange(row('  Realname Alpha  '), 'zorp', PII)).toBe('stored_is_roster_real_name');
  });

  it('reports a gap fill separately — nothing is being removed', () => {
    expect(classifyChange(row(null), 'zorp', PII)).toBe('stored_null');
  });

  it('ranks the PII case above a null recompute', () => {
    // Removing a real name is the outcome we want counted as PII removal,
    // even though the write also happens to null the column.
    expect(classifyChange(row('Realname Alpha'), null, PII)).toBe('stored_is_roster_real_name');
  });

  it('flags nulling a NON-roster value as unexplained attribution loss', () => {
    // This is the class that should be near zero. A non-empty count here means
    // the job is erasing handles it cannot justify as PII.
    expect(classifyChange(row('some handle'), null, PII)).toBe('recomputed_null_non_pii');
  });

  it('separates a whitespace-only difference — a cosmetic write', () => {
    expect(classifyChange(row('  zorp  '), 'zorp', PII)).toBe('whitespace_only');
  });

  it('separates a case-only difference', () => {
    expect(classifyChange(row('ZORP'), 'zorp', PII)).toBe('case_only');
  });

  it('falls through to a plain value change when nothing else explains it', () => {
    // e.g. a DJ who changed their own handle. Legitimate, but not PII removal,
    // and it should not be counted as such.
    expect(classifyChange(row('old handle'), 'new handle', PII)).toBe('other_value_change');
  });

  // BS#2281 review finding 2: what a write would ITSELF WRITE, not what it
  // removes. Ranked above stored_is_roster_real_name — see the docstring.
  describe('recomputed_is_roster_real_name — the write-side guard', () => {
    it('flags a recompute that lands on a roster real name', () => {
      expect(classifyChange(row('stale handle'), 'Realname Alpha', PII)).toBe('recomputed_is_roster_real_name');
    });

    it('ranks ABOVE stored_is_roster_real_name when both would fire', () => {
      const bothPii = new Set(['Realname Alpha', 'Realname Beta']);
      expect(classifyChange(row('Realname Alpha'), 'Realname Beta', bothPii)).toBe('recomputed_is_roster_real_name');
    });

    it('matches on the trimmed recomputed value', () => {
      expect(classifyChange(row('stale'), '  Realname Alpha  ', PII)).toBe('recomputed_is_roster_real_name');
    });
  });

  // BS#2281 review finding 1: the blind spot in stored_is_roster_real_name.
  describe('stored_is_superseded_legacy_name — the cohort-B signature', () => {
    it('flags a stored value superseded by a legacy-arm recompute', () => {
      // The row's legacy_dj_name is the winning arm's output verbatim, and it
      // differs from what is stored — exactly the BS#1393 cohort-B shape.
      expect(classifyChange(row('old real name', 'legacy handle'), 'legacy handle', PII)).toBe(
        'stored_is_superseded_legacy_name'
      );
    });

    it('ranks BELOW stored_is_roster_real_name — a confirmed match beats an inferred one', () => {
      const row2 = row('Realname Alpha', 'legacy handle');
      expect(classifyChange(row2, 'legacy handle', PII)).toBe('stored_is_roster_real_name');
    });

    it('does not fire when the recompute does not equal legacy_dj_name verbatim', () => {
      // e.g. the trimmed-legacy branch of resolveShowDjName, or a live
      // show_start's override/handle arm — neither returns legacy_dj_name AS
      // STORED, so this is an ordinary value change, not the cohort-B shape.
      expect(classifyChange(row('old', '  legacy  '), 'legacy', PII)).toBe('other_value_change');
    });

    it('does not fire when there is no legacy_dj_name to match against', () => {
      // The `track`/`show_end` live arm and the `show_start` live arm never
      // read legacy_dj_name — row.legacy_dj_name is null for them, so the
      // verbatim-equality check can never accidentally match a null recompute.
      expect(classifyChange(row('old handle', null), 'new handle', PII)).toBe('other_value_change');
    });
  });
});
