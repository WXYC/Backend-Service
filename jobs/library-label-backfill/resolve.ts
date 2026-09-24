/**
 * Resolve one label per library card from tubafrenzy's acquisition record
 * (BS#2669).
 *
 * The input for a card is every `ROTATION_RELEASE` row that names it, each
 * carrying a `COMPANY_ID` foreign key. The label therefore arrives as an
 * **identity, not as text** — there is no spelling to normalize, nothing to
 * vote on, and no unanimity rule to apply. A card resolves when its rotation
 * rows name one label; a card whose re-adds name two different labels is a
 * genuine multi-label case and is emitted as a conflict with no value.
 *
 * ## Why identity beats the free-text route
 *
 * The first implementation of this ticket read `FLOWSHEET_ENTRY_PROD.LABEL_NAME`
 * and resolved it by modal vote. That column pools two provenances under one
 * name: rotation-linked plays carry a label the system copied off the
 * `ROTATION_RELEASE` record (100.0% fill), and everything else is free text a
 * DJ typed per play (84.0% fill) describing whatever object was in their hands
 * — which nothing records as being the library's copy. `library.label` exists
 * to answer "which pressing does WXYC hold", so an unverifiable label is not
 * weak evidence, it is the wrong kind of evidence. The cost is asymmetric: a
 * missing label makes discogs-etl's `label_match` key abstain, which is the
 * status quo for every card today and costs nothing, while a wrong one
 * promotes the wrong pressing station-wide and is indistinguishable from a
 * right one downstream.
 *
 * ## Comparison is by name, not by id
 *
 * `COMPANY` holds 7,246 rows but only 5,964 distinct names: 520 names sit on
 * two or more ids ("atlantic" is 123, 6446 and 6486), because the table
 * accumulated a fresh row each time someone re-entered a label over ~20 years.
 * Grouping a card's rotation rows by raw `COMPANY_ID` would call 51 such cards
 * conflicted when every id names the same label. Grouping by case-folded name
 * resolves them — 17,088 cards rather than 17,037 — and 7 of those cards
 * differ only in letter case ("Atlantic" vs "atlantic"), which is why the fold
 * is case-insensitive rather than exact.
 *
 * That fold is the *only* text handling in this module, and it is a
 * case-insensitive comparison of curated foreign-key targets — not the
 * punctuation-stripping, suffix-dropping, diacritic-folding rule the free-text
 * route needed. The duplication is tubafrenzy's, and BS#2672 must collapse it
 * to one `wxyc_schema.labels` row per name rather than carrying three
 * "Atlantic" rows across: {@link CardLabel.companyIds} lists every id behind a
 * resolved name so the write side can see what it is collapsing.
 */

/** A `COMPANY` row, reduced to what this job needs. */
export interface Company {
  id: number;
  /** `COMPANY.NAME`, trimmed. Never empty — empty names are not loaded. */
  name: string;
}

/** One `ROTATION_RELEASE` row that names a library card. */
export interface RotationRow {
  /** `ROTATION_RELEASE.LIBRARY_RELEASE_ID`. Always > 0. */
  legacyReleaseId: number;
  /** `ROTATION_RELEASE.COMPANY_ID`, or `null` when absent/unresolvable. */
  companyId: number | null;
  /** `ROTATION_RELEASE.ALTERNATE_LABEL_NAME`, trimmed; `''` when absent. */
  alternateLabelName: string;
}

/** The label candidates sharing one case-folded name, on one card. */
export interface NameGroup {
  /** The case-folded comparison key. */
  folded: string;
  /** The exact `COMPANY.NAME` to display — the most-seen spelling. */
  name: string;
  /** Every `COMPANY_ID` on this card whose name folds here, ascending. */
  companyIds: number[];
  /** `ROTATION_RELEASE` rows on this card naming this label. */
  rotationRows: number;
}

/** The verdict for one library card. */
export interface CardLabel {
  /** Tubafrenzy `LIBRARY_RELEASE_ID`. Never resolved to `library.id` here. */
  legacyReleaseId: number;
  /** `resolved` iff the card's rotation rows name exactly one label. */
  status: 'resolved' | 'conflict';
  /** `COMPANY.NAME` to write, or `null` for a conflict. */
  labelName: string | null;
  /**
   * The `COMPANY_ID` to write to `library.label_id`, or `null` for a conflict.
   * When one name sits on several ids this is the most-used of them, lowest id
   * breaking a tie — see {@link companyIds} for the full set.
   */
  companyId: number | null;
  /** Every id behind the resolved name, ascending; empty for a conflict. */
  companyIds: number[];
  /** `ROTATION_RELEASE` rows naming this card. */
  rotationRows: number;
  /** Every distinct label on the card, most-used first. */
  groups: NameGroup[];
}

/**
 * Case-fold a `COMPANY.NAME` for comparison.
 *
 * Trim plus lowercase, and nothing else. These are curated table rows, not
 * typed-per-play free text, so the only variation worth absorbing is the
 * duplicate-row-with-different-capitalisation case the `COMPANY` table
 * actually contains.
 *
 * @param name - a `COMPANY.NAME`
 * @returns the comparison key
 */
export function foldCompanyName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve one card's label from its rotation rows.
 *
 * @param legacyReleaseId - the card's tubafrenzy `LIBRARY_RELEASE_ID`
 * @param rows - every `ROTATION_RELEASE` row naming this card
 * @param companies - `COMPANY_ID` → row, for id resolution
 * @returns the verdict, or `null` when no row carried a resolvable
 *          `COMPANY_ID` (the card is simply not covered by this route)
 */
export function resolveCardLabel(
  legacyReleaseId: number,
  rows: readonly RotationRow[],
  companies: ReadonlyMap<number, Company>
): CardLabel | null {
  /** folded name → id → rows using that id */
  const byFolded = new Map<string, Map<number, number>>();

  for (const row of rows) {
    if (row.companyId === null) continue;
    const company = companies.get(row.companyId);
    if (company === undefined || company.name === '') continue;
    const folded = foldCompanyName(company.name);
    let ids = byFolded.get(folded);
    if (!ids) {
      ids = new Map<number, number>();
      byFolded.set(folded, ids);
    }
    ids.set(row.companyId, (ids.get(row.companyId) ?? 0) + 1);
  }

  if (byFolded.size === 0) return null;

  const groups: NameGroup[] = [];
  for (const [folded, ids] of byFolded) {
    // Most-used id wins the display spelling and the emitted label_id; lowest
    // id breaks a tie so the committed file is byte-stable across runs.
    const ranked = [...ids.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const rotationRows = ranked.reduce((sum, [, n]) => sum + n, 0);
    groups.push({
      folded,
      name: companies.get(ranked[0][0])?.name ?? '',
      companyIds: [...ids.keys()].sort((a, b) => a - b),
      rotationRows,
    });
  }
  groups.sort((a, b) => b.rotationRows - a.rotationRows || a.folded.localeCompare(b.folded, 'en'));

  const rotationRows = groups.reduce((sum, g) => sum + g.rotationRows, 0);

  if (groups.length > 1) {
    return {
      legacyReleaseId,
      status: 'conflict',
      labelName: null,
      companyId: null,
      companyIds: [],
      rotationRows,
      groups,
    };
  }

  const only = groups[0];
  const ids = byFolded.get(only.folded) as Map<number, number>;
  const winner = [...ids.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return {
    legacyReleaseId,
    status: 'resolved',
    labelName: only.name,
    companyId: winner,
    companyIds: only.companyIds,
    rotationRows,
    groups,
  };
}

/** Aggregate figures for the report. */
export interface LabelSummary {
  /** Distinct cards named by a rotation row with a resolvable `COMPANY_ID`. */
  cardsCovered: number;
  /** Cards whose rotation rows name exactly one label. */
  cardsResolved: number;
  /** Cards naming two or more different labels across re-adds. */
  cardsConflicted: number;
  /** Distinct `COMPANY.NAME` values across every resolved card. */
  distinctLabels: number;
  /** Distinct `COMPANY_ID` values emitted across every resolved card. */
  distinctCompanyIds: number;
  /**
   * Resolved cards whose single label sits on more than one `COMPANY_ID` —
   * the duplicate-`COMPANY`-row population BS#2672 must collapse.
   */
  cardsWithDuplicateCompanyRows: number;
}

/**
 * Fold per-card verdicts into the figures the report prints.
 *
 * @param labels - every verdict, in any order
 */
export function summarize(labels: readonly CardLabel[]): LabelSummary {
  const names = new Set<string>();
  const ids = new Set<number>();
  let cardsResolved = 0;
  let cardsWithDuplicateCompanyRows = 0;

  for (const l of labels) {
    if (l.status !== 'resolved') continue;
    cardsResolved++;
    if (l.labelName !== null) names.add(foldCompanyName(l.labelName));
    if (l.companyId !== null) ids.add(l.companyId);
    if (l.companyIds.length > 1) cardsWithDuplicateCompanyRows++;
  }

  return {
    cardsCovered: labels.length,
    cardsResolved,
    cardsConflicted: labels.length - cardsResolved,
    distinctLabels: names.size,
    distinctCompanyIds: ids.size,
    cardsWithDuplicateCompanyRows,
  };
}
