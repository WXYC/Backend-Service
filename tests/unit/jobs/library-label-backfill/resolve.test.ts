/**
 * Per-card label resolution (BS#2669).
 *
 * The property this suite defends is abstention. `library.label` feeds
 * discogs-etl's `label_match` dedup ranking key, so a manufactured value
 * promotes the wrong pressing for the whole station. A card resolves ONLY when
 * every play agrees after normalization; anything else is a conflict carrying
 * no candidate. The modal vote settles which *spelling* to display inside an
 * already-unanimous group — it never picks a winner between disagreeing ones.
 */

import { resolveCard, summarize } from '../../../../jobs/library-label-backfill/resolve';

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('resolveCard', () => {
  it('resolves a card whose plays all typed the same label', () => {
    const r = resolveCard(100, counts({ 'Sub Pop': 12 }));
    expect(r).toMatchObject({
      legacyReleaseId: 100,
      status: 'resolved',
      resolvedLabel: 'Sub Pop',
      normalizedLabel: 'subpop',
      plays: 12,
    });
  });

  it('resolves spelling noise and displays the most common raw form', () => {
    const r = resolveCard(101, counts({ 'Sub Pop Records': 40, 'Sub Pop': 9, 'sub-pop records': 1 }));
    expect(r?.status).toBe('resolved');
    expect(r?.normalizedLabel).toBe('subpop');
    expect(r?.resolvedLabel).toBe('Sub Pop Records');
    expect(r?.plays).toBe(50);
    expect(r?.groups).toHaveLength(1);
    expect(r?.groups[0].variants.map((v) => v.raw)).toEqual(['Sub Pop Records', 'Sub Pop', 'sub-pop records']);
  });

  it('emits a conflict with NO candidate when labels genuinely disagree', () => {
    const r = resolveCard(102, counts({ Matador: 30, 'Sub Pop': 2 }));
    expect(r?.status).toBe('conflict');
    expect(r?.resolvedLabel).toBeNull();
    expect(r?.normalizedLabel).toBeNull();
  });

  it('does not let an overwhelming majority override a real disagreement', () => {
    // 999 vs 1 is still two labels. Abstaining here is the whole point.
    const r = resolveCard(103, counts({ 'Drag City': 999, Domino: 1 }));
    expect(r?.status).toBe('conflict');
    expect(r?.resolvedLabel).toBeNull();
  });

  it('ignores spellings that carry no label information', () => {
    const r = resolveCard(104, counts({ 'Drag City': 5, Records: 3, '---': 1 }));
    expect(r?.status).toBe('resolved');
    expect(r?.resolvedLabel).toBe('Drag City');
    // The dropped spellings contribute no plays to the resolved total.
    expect(r?.plays).toBe(5);
  });

  it('returns null when every spelling normalizes away', () => {
    expect(resolveCard(105, counts({ Records: 4, 'Music, Inc.': 2 }))).toBeNull();
  });

  it('orders groups and variants by plays, then name, so output is reproducible', () => {
    const r = resolveCard(106, counts({ Bbb: 5, Aaa: 5, Ccc: 9 }));
    expect(r?.groups.map((g) => g.normalized)).toEqual(['ccc', 'aaa', 'bbb']);
  });

  it('counts plays across every surviving group on a conflict', () => {
    const r = resolveCard(107, counts({ 'Thrill Jockey': 3, 'Thrill Jockey Records': 4, Kranky: 2 }));
    expect(r?.status).toBe('conflict');
    expect(r?.groups).toHaveLength(2);
    expect(r?.groups[0]).toMatchObject({ normalized: 'thrilljockey', plays: 7 });
    expect(r?.plays).toBe(9);
  });
});

describe('summarize', () => {
  it('reports coverage, the conflict residue and both distributions', () => {
    const raw = new Map([
      [1, counts({ 'Sub Pop': 10 })], // single-valued raw, resolves
      [2, counts({ 'Sub Pop': 4, 'Sub Pop Records': 1 })], // 2 raw, resolves
      [3, counts({ Matador: 3, 'Drag City': 1 })], // 2 raw, conflicts
      [4, counts({ Records: 2 })], // normalizes away entirely
    ]);
    const resolutions = [...raw].flatMap(([id, c]) => {
      const r = resolveCard(id, c);
      return r === null ? [] : [r];
    });

    const s = summarize(raw, resolutions);
    expect(s).toMatchObject({
      cardsWithAnyRawLabel: 4,
      cardsSingleValuedRaw: 2, // cards 1 and 4
      cardsAfterNormalization: 3, // card 4 dropped out
      cardsResolved: 2,
      cardsConflicted: 1,
      distinctResolvedLabels: 1, // both resolved cards display "Sub Pop"
    });
    expect([...s.rawVariantDistribution.entries()].sort()).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect([...s.groupCountDistribution.entries()].sort()).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it('is empty-safe', () => {
    const s = summarize(new Map(), []);
    expect(s).toMatchObject({
      cardsWithAnyRawLabel: 0,
      cardsResolved: 0,
      cardsConflicted: 0,
      distinctResolvedLabels: 0,
    });
  });
});
