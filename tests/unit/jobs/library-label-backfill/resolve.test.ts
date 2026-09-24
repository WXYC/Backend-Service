/**
 * Per-card label resolution from the acquisition record (BS#2669).
 *
 * Two properties this suite defends, both of which a "tidy-up" would quietly
 * break:
 *
 *   - **Abstention on genuine disagreement.** `library.label` feeds
 *     discogs-etl's `label_match` dedup ranking key, so a manufactured value
 *     promotes the wrong pressing station-wide. A card whose re-adds name two
 *     different labels gets no value at all — not the most-used one.
 *   - **Duplicate `COMPANY` rows are not disagreement.** That table grew a
 *     fresh row each time a label was re-entered ("atlantic" is ids 123, 6446
 *     and 6486), so comparison is by case-folded NAME. Comparing by raw
 *     `COMPANY_ID` would abstain on 51 cards whose label is unambiguous.
 */

import {
  foldCompanyName,
  resolveCardLabel,
  summarize,
  type Company,
  type RotationRow,
} from '../../../../jobs/library-label-backfill/resolve';

const companies = (...entries: [number, string][]): Map<number, Company> =>
  new Map(entries.map(([id, name]) => [id, { id, name }]));

const rows = (...companyIds: (number | null)[]): RotationRow[] =>
  companyIds.map((companyId) => ({ legacyReleaseId: 1, companyId, alternateLabelName: '' }));

const CO = companies([10, 'Sub Pop'], [11, 'Matador'], [12, 'sub pop'], [13, 'SUB POP'], [14, 'Drag City']);

describe('foldCompanyName', () => {
  it.each([
    ['Sub Pop', 'sub pop'],
    ['  Sub Pop  ', 'sub pop'],
    ['SUB POP', 'sub pop'],
  ])('folds %p to %p', (raw, expected) => {
    expect(foldCompanyName(raw)).toBe(expected);
  });

  it('does not touch punctuation, spacing or diacritics', () => {
    // Deliberately NOT the free-text rule: these are curated FK targets, and
    // two differently-punctuated COMPANY rows are two different labels here.
    expect(foldCompanyName('Sub-Pop')).toBe('sub-pop');
    expect(foldCompanyName('Sub Pop Records')).toBe('sub pop records');
    expect(foldCompanyName('Barbès')).toBe('barbès');
    expect(foldCompanyName('Sub-Pop')).not.toBe(foldCompanyName('Sub Pop'));
  });
});

describe('resolveCardLabel', () => {
  it('resolves a card with one rotation row', () => {
    expect(resolveCardLabel(100, rows(10), CO)).toMatchObject({
      legacyReleaseId: 100,
      status: 'resolved',
      labelName: 'Sub Pop',
      companyId: 10,
      companyIds: [10],
      rotationRows: 1,
    });
  });

  it('resolves a card re-added under the same label', () => {
    expect(resolveCardLabel(101, rows(10, 10, 10), CO)).toMatchObject({
      status: 'resolved',
      companyId: 10,
      rotationRows: 3,
    });
  });

  it('returns null when no row carries a resolvable COMPANY_ID', () => {
    expect(resolveCardLabel(102, rows(null, null), CO)).toBeNull();
    // An id with no COMPANY row is unresolvable too.
    expect(resolveCardLabel(103, rows(9999), CO)).toBeNull();
  });

  it('ignores unresolvable rows alongside resolvable ones', () => {
    const r = resolveCardLabel(104, rows(10, null, 9999), CO);
    expect(r).toMatchObject({ status: 'resolved', companyId: 10, rotationRows: 1 });
  });

  describe('duplicate COMPANY rows are one label', () => {
    it('resolves a card whose ids share a name', () => {
      const r = resolveCardLabel(105, rows(10, 12), CO);
      expect(r?.status).toBe('resolved');
      expect(foldCompanyName(r?.labelName ?? '')).toBe('sub pop');
      expect(r?.companyIds).toEqual([10, 12]);
    });

    it('folds case, since COMPANY holds both "Atlantic" and "atlantic"', () => {
      const r = resolveCardLabel(106, rows(10, 13), CO);
      expect(r?.status).toBe('resolved');
      expect(r?.companyIds).toEqual([10, 13]);
    });

    it('emits the most-used id as company_id, lowest id breaking a tie', () => {
      expect(resolveCardLabel(107, rows(12, 12, 10), CO)?.companyId).toBe(12);
      // 10 and 12 used once each -> lowest wins, so the file is byte-stable.
      expect(resolveCardLabel(108, rows(12, 10), CO)?.companyId).toBe(10);
    });

    it('displays the spelling of the winning id', () => {
      expect(resolveCardLabel(109, rows(12, 12, 10), CO)?.labelName).toBe('sub pop');
      expect(resolveCardLabel(110, rows(10, 10, 12), CO)?.labelName).toBe('Sub Pop');
    });
  });

  describe('genuine multi-label cards abstain', () => {
    it('emits a conflict with no value', () => {
      const r = resolveCardLabel(111, rows(10, 11), CO);
      expect(r).toMatchObject({ status: 'conflict', labelName: null, companyId: null, companyIds: [] });
      expect(r?.groups).toHaveLength(2);
    });

    it('does not let an overwhelming majority override a real second label', () => {
      const r = resolveCardLabel(112, rows(...Array<number>(99).fill(10), 11), CO);
      expect(r?.status).toBe('conflict');
      expect(r?.labelName).toBeNull();
    });

    it('orders groups by rotation rows, then name, so output is reproducible', () => {
      const r = resolveCardLabel(113, rows(11, 14, 14), CO);
      expect(r?.groups.map((g) => g.name)).toEqual(['Drag City', 'Matador']);
      expect(r?.rotationRows).toBe(3);
    });
  });
});

describe('summarize', () => {
  it('reports coverage, conflicts and the duplicate-COMPANY population', () => {
    const labels = [
      resolveCardLabel(1, rows(10), CO),
      resolveCardLabel(2, rows(10, 12), CO), // same label, two ids
      resolveCardLabel(3, rows(11), CO),
      resolveCardLabel(4, rows(10, 11), CO), // conflict
    ].filter((l) => l !== null);

    expect(summarize(labels)).toMatchObject({
      cardsCovered: 4,
      cardsResolved: 3,
      cardsConflicted: 1,
      distinctLabels: 2, // "sub pop" and "matador"
      distinctCompanyIds: 2, // 10 and 11
      cardsWithDuplicateCompanyRows: 1, // card 2
    });
  });

  it('is empty-safe', () => {
    expect(summarize([])).toMatchObject({ cardsCovered: 0, cardsResolved: 0, cardsConflicted: 0, distinctLabels: 0 });
  });
});
