import { formatSummary, type RunSummary } from '../../../../jobs/digital-archive-bind/report';

const baseSummary: RunSummary = {
  mode: 'dry-run',
  filesSeen: 100,
  skippedByReason: { 'non-audio-extension': 3, 'not-content-prefix': 2 },
  albumsGrouped: 10,
  ungroupableFiles: 1,
  matchedExact: 6,
  matchedFuzzy: 1,
  ambiguous: 1,
  unmatched: 2,
  inserted: 7,
  reopened: 0,
  rejectedBlocked: [],
  boundDrift: [],
  sameRunCollision: [],
};

describe('digital-archive-bind report', () => {
  it('renders the counts a dry run promises', () => {
    const text = formatSummary(baseSummary);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('files seen:        100');
    expect(text).toContain('would insert (needs_review): 7');
    expect(text).toContain('skipped (non-audio-extension): 3');
  });

  it('never reports a blocked or bound-drift row silently -- object keys and slot are always printed', () => {
    const summary: RunSummary = {
      ...baseSummary,
      rejectedBlocked: [{ libraryId: 5, discNumber: 1, objectKeys: ['a.mp3', 'b.mp3'] }],
      boundDrift: [{ assetId: 9, libraryId: 6, discNumber: 1, candidateKeys: ['new.mp3'], boundKeys: ['old.mp3'] }],
    };
    const text = formatSummary(summary);
    expect(text).toContain('a.mp3, b.mp3');
    expect(text).toContain('--rebind-keys');
    expect(text).toContain('old.mp3');
    expect(text).toContain('new.mp3');
  });

  it('reports a same-run collision with its slot and object keys', () => {
    const summary: RunSummary = {
      ...baseSummary,
      sameRunCollision: [{ libraryId: 5, discNumber: 1, objectKeys: ['rotation.mp3'] }],
    };
    const text = formatSummary(summary);
    expect(text).toContain('library_id=5 disc=1: rotation.mp3');
  });

  it("labels an apply run's counts as done, not projected", () => {
    const text = formatSummary({ ...baseSummary, mode: 'apply' });
    expect(text).toContain('inserted (needs_review): 7');
    expect(text).not.toContain('would insert');
  });
});
