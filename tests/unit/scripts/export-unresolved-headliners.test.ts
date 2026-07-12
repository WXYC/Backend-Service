/**
 * Unit tests for the BS#1614 name-set export filter (PR 1).
 *
 * `summarizeHeadlinerDump` is the pure half of
 * scripts/export-unresolved-headliners.ts: raw dump lines (one
 * `headlining_artist_raw` per line, psql -At output) -> the clean-name
 * list handed to LML#759's drain script, plus the gated-out breakdown
 * that becomes the fresh measurement posted to BS#1614.
 */
import { summarizeHeadlinerDump, formatSummary } from '../../../scripts/lib/headliner-export';

const DUMP = [
  '(SOLD OUT) Jessica Pratt', // legacy pre-BS#1604 row: extraction cleans it
  'Jessica Pratt', // post-extraction duplicate of the same artist
  'Wishy, special guest TBA', // comma billing
  'REZN + Yawning Man', // ` + ` billing
  'Magic City Hippies / Flipturn', // ` / ` billing
  'Elvis Costello with Steve Nieve', // plain ` with ` billing
  '(18+)', // pure ticketing tag (extraction fallback returns it verbatim)
  'Duke Ellington & John Coltrane', // `&` act — clean by design
  '', // blank lines dropped
  '   ',
  'Wishy',
];

describe('summarizeHeadlinerDump', () => {
  const summary = summarizeHeadlinerDump(DUMP);

  it('emits the sorted distinct clean-name list, deduped on the extracted form', () => {
    // '(SOLD OUT) Jessica Pratt' and 'Jessica Pratt' collapse to one entry.
    expect(summary.clean).toEqual(['Duke Ellington & John Coltrane', 'Jessica Pratt', 'Wishy']);
  });

  it('counts lines, distinct raws, and extraction-changed raws', () => {
    expect(summary.totalLines).toBe(11);
    expect(summary.distinctRaw).toBe(9); // trimmed non-empty distinct
    expect(summary.extractionChanged).toBe(1); // only the (SOLD OUT) row
  });

  it('buckets gated-out names by first-matching reason', () => {
    expect(summary.gated.comma).toEqual(['Wishy, special guest TBA']);
    expect(summary.gated.plus).toEqual(['REZN + Yawning Man']);
    expect(summary.gated.slash).toEqual(['Magic City Hippies / Flipturn']);
    expect(summary.gated.with).toEqual(['Elvis Costello with Steve Nieve']);
    expect(summary.gated.extraction_residue).toEqual(['(18+)']);
  });

  it('is stable under a re-run over its own clean output (idempotent handoff)', () => {
    const again = summarizeHeadlinerDump(summary.clean);
    expect(again.clean).toEqual(summary.clean);
    expect(Object.values(again.gated).flat()).toEqual([]);
  });

  it('handles an empty dump', () => {
    const empty = summarizeHeadlinerDump([]);
    expect(empty.clean).toEqual([]);
    expect(empty.totalLines).toBe(0);
    expect(empty.distinctRaw).toBe(0);
  });
});

describe('formatSummary', () => {
  it('renders the measurement block with counts and the gated breakdown', () => {
    const text = formatSummary(summarizeHeadlinerDump(DUMP));
    expect(text).toContain('distinct raw names: 9');
    expect(text).toContain('clean (LML-eligible): 3');
    expect(text).toContain('gated out: 5');
    expect(text).toContain('comma: 1');
    expect(text).toContain('plus: 1');
    expect(text).toContain('slash: 1');
    expect(text).toContain('with: 1');
    expect(text).toContain('extraction_residue: 1');
  });
});
