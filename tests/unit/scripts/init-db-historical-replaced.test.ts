/**
 * Source-grep tests for the `HISTORICAL_REPLACED_TAGS` allowlist in
 * `dev_env/init-db.mjs`. Each entry in that map records a journal tag
 * whose hash will never appear in `drizzle.__drizzle_migrations` because
 * drizzle's "max(applied.created_at) cursor" silently skipped it; a
 * later replay migration carries the effects forward instead.
 *
 * The verifier in init-db.mjs tolerates an entry being absent only if
 * its replay migration *is* applied. This file validates the allowlist
 * itself: that the migrations it names exist in the journal, that each
 * skipped entry has a paired replay, and that the replay numerically
 * follows the original (so its `when` is above drizzle's cursor).
 *
 * The behavioural test of the verifier (what happens when a hash is
 * absent) lives at integration-test time, where a real PG and migrate
 * runner are available; this file only exercises the data shape so a
 * future PR cannot list a tag that doesn't exist or point to a replay
 * that isn't really a replay.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const initDbPath = path.join(repoRoot, 'dev_env/init-db.mjs');
const journalPath = path.join(repoRoot, 'shared/database/src/migrations/meta/_journal.json');

const initDbSource = fs.readFileSync(initDbPath, 'utf-8');
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const journalTags = new Set(journal.entries.map((e) => e.tag));

/**
 * Parse the `HISTORICAL_REPLACED_TAGS = new Map([...])` literal out of
 * init-db.mjs source. The map is plain string-to-string, so a regex
 * extraction is robust enough; if the structure changes (e.g., to JSON
 * import) update this and the verifier together.
 */
function parseHistoricalReplacedTags(): Map<string, string> {
  const blockMatch = initDbSource.match(/HISTORICAL_REPLACED_TAGS\s*=\s*new\s+Map\(\[([\s\S]*?)\]\);/);
  if (!blockMatch) throw new Error('HISTORICAL_REPLACED_TAGS not found in init-db.mjs');
  const pairs = new Map<string, string>();
  const pairRe = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(blockMatch[1])) !== null) {
    pairs.set(m[1], m[2]);
  }
  if (pairs.size === 0) throw new Error('HISTORICAL_REPLACED_TAGS is empty');
  return pairs;
}

describe('init-db.mjs: HISTORICAL_REPLACED_TAGS allowlist', () => {
  let allowlist: Map<string, string>;

  beforeAll(() => {
    allowlist = parseHistoricalReplacedTags();
  });

  it('every skipped tag exists in the journal', () => {
    for (const skippedTag of allowlist.keys()) {
      expect(journalTags.has(skippedTag)).toBe(true);
    }
  });

  it('every replay tag exists in the journal', () => {
    for (const replayTag of allowlist.values()) {
      expect(journalTags.has(replayTag)).toBe(true);
    }
  });

  it('every replay migration sits at a higher idx than the migration it replays', () => {
    // drizzle applies migrations in journal-array order (and skips entries
    // below max(applied.created_at)). For a replay to actually run, it
    // must come *after* the skipped entry in the journal.
    const idxByTag = new Map<string, number>(journal.entries.map((e) => [e.tag, e.idx]));
    for (const [skippedTag, replayTag] of allowlist) {
      const skippedIdx = idxByTag.get(skippedTag);
      const replayIdx = idxByTag.get(replayTag);
      if (skippedIdx === undefined || replayIdx === undefined) {
        throw new Error(`tag missing from journal: ${skippedTag} or ${replayTag}`);
      }
      expect(replayIdx).toBeGreaterThan(skippedIdx);
    }
  });

  it('every replay migration has a `when` timestamp above the skipped one', () => {
    // Beyond just sitting at a higher idx, the replay's `when` must be
    // monotonically above the cursor — otherwise drizzle's filter would
    // also skip the replay and we'd be in the same bind we are recovering
    // from.
    const whenByTag = new Map<string, number>(journal.entries.map((e) => [e.tag, e.when]));
    for (const [skippedTag, replayTag] of allowlist) {
      const skippedWhen = whenByTag.get(skippedTag);
      const replayWhen = whenByTag.get(replayTag);
      if (skippedWhen === undefined || replayWhen === undefined) {
        throw new Error(`tag missing from journal: ${skippedTag} or ${replayTag}`);
      }
      expect(replayWhen).toBeGreaterThan(skippedWhen);
    }
  });

  it('every replay tag is unique (no two skipped tags claim the same replay)', () => {
    const replayCounts = new Map<string, number>();
    for (const replayTag of allowlist.values()) {
      replayCounts.set(replayTag, (replayCounts.get(replayTag) ?? 0) + 1);
    }
    for (const [tag, count] of replayCounts) {
      expect(`${tag}: ${count}`).toBe(`${tag}: 1`);
    }
  });

  it('the verifier conditions absence on the replay being applied', () => {
    // Source-grep guard: the verifier must check `appliedHashes.has(replay.hash)`
    // before treating the original as expected-absent. Without that check,
    // a database where neither original nor replay applied would silently
    // pass verification — the exact opposite of what we want.
    expect(initDbSource).toMatch(/appliedHashes\.has\(\s*replay\.hash\s*\)/);
  });
});
