/**
 * Modal-vote resolution of a card's typed labels into one canonical value
 * (BS#2669).
 *
 * The input for one card is the multiset of raw `LABEL_NAME` strings its plays
 * carry. {@link resolveCard} groups those by {@link normalizeLabel}, and the
 * card is **resolved** only when exactly one non-empty normalized group
 * survives. A card with two or more surviving groups is emitted as a
 * **conflict** with no resolved value.
 *
 * That asymmetry is the whole design. A wrong label is worse than a missing
 * one here: `library.label` feeds discogs-etl's `label_match` dedup ranking
 * key, which decides which pressing the entire station sees for a release. A
 * modal vote over genuinely disagreeing labels would manufacture confidence
 * the data does not contain — and a reissue legitimately carries different
 * labels across plays, so disagreement is not always error. The modal vote
 * therefore settles *spelling*, never *substance*: it picks the display form
 * within an already-unanimous group and abstains everywhere else.
 */

import { normalizeLabel } from './normalize';

/** One raw spelling and how many plays used it. */
export interface RawVariant {
  /** The label exactly as typed. */
  raw: string;
  /** Plays on this card carrying this exact spelling. */
  plays: number;
}

/** Raw spellings that share a normalized form. */
export interface LabelGroup {
  /** The shared {@link normalizeLabel} output. Never empty. */
  normalized: string;
  /** Total plays across every spelling in the group. */
  plays: number;
  /** Spellings, most-played first; ties broken lexicographically. */
  variants: RawVariant[];
}

/** The verdict for one library card. */
export interface CardResolution {
  /** Tubafrenzy `LIBRARY_RELEASE_ID`. Never resolved to `library.id` here. */
  legacyReleaseId: number;
  /** `resolved` iff exactly one non-empty normalized group survived. */
  status: 'resolved' | 'conflict';
  /**
   * The display spelling to write, or `null` for a conflict. Conflicts carry
   * no candidate on purpose — see this module's header.
   */
  resolvedLabel: string | null;
  /** The normalized key behind {@link resolvedLabel}, or `null`. */
  normalizedLabel: string | null;
  /** Labelled plays on this card that survived normalization. */
  plays: number;
  /** Every surviving group, most-played first. */
  groups: LabelGroup[];
}

/**
 * Deterministic ordering for anything the mapping file prints: most plays
 * first, then lexicographic. Without the second key the output would reorder
 * between runs on ties and the committed file would churn.
 */
const byPlaysThenName = <T extends { plays: number }>(key: (t: T) => string) => {
  return (a: T, b: T): number => b.plays - a.plays || key(a).localeCompare(key(b), 'en');
};

/**
 * Resolve one card's typed labels.
 *
 * @param legacyReleaseId - the card's tubafrenzy `LIBRARY_RELEASE_ID`
 * @param rawCounts - raw `LABEL_NAME` → play count, for this card only
 * @returns the verdict, or `null` when every spelling normalized away to
 *          nothing (the card carried no label information)
 */
export function resolveCard(legacyReleaseId: number, rawCounts: ReadonlyMap<string, number>): CardResolution | null {
  const byNormalized = new Map<string, RawVariant[]>();

  for (const [raw, plays] of rawCounts) {
    const normalized = normalizeLabel(raw);
    if (normalized === '') continue;
    const bucket = byNormalized.get(normalized);
    if (bucket) bucket.push({ raw, plays });
    else byNormalized.set(normalized, [{ raw, plays }]);
  }

  if (byNormalized.size === 0) return null;

  const groups: LabelGroup[] = [];
  for (const [normalized, variants] of byNormalized) {
    variants.sort(byPlaysThenName<RawVariant>((v) => v.raw));
    groups.push({ normalized, plays: variants.reduce((s, v) => s + v.plays, 0), variants });
  }
  groups.sort(byPlaysThenName<LabelGroup>((g) => g.normalized));

  const plays = groups.reduce((s, g) => s + g.plays, 0);

  if (groups.length > 1) {
    return { legacyReleaseId, status: 'conflict', resolvedLabel: null, normalizedLabel: null, plays, groups };
  }

  const only = groups[0];
  return {
    legacyReleaseId,
    status: 'resolved',
    // Most-played spelling within the unanimous group is the display value.
    resolvedLabel: only.variants[0].raw,
    normalizedLabel: only.normalized,
    plays,
    groups,
  };
}

/** Aggregate figures for the report. */
export interface ResolutionSummary {
  /** Cards with at least one non-empty raw `LABEL_NAME`. */
  cardsWithAnyRawLabel: number;
  /** Of those, cards where every play typed the same raw string. */
  cardsSingleValuedRaw: number;
  /** Cards surviving normalization (at least one non-empty normalized form). */
  cardsAfterNormalization: number;
  /** Cards resolved — exactly one surviving normalized group. */
  cardsResolved: number;
  /** Cards left conflicted. */
  cardsConflicted: number;
  /** Surviving-group count → how many cards had that many. */
  groupCountDistribution: Map<number, number>;
  /** Raw-variant count → how many cards had that many, before normalization. */
  rawVariantDistribution: Map<number, number>;
  /** Distinct resolved display labels across every resolved card. */
  distinctResolvedLabels: number;
}

/**
 * Fold per-card verdicts into the figures the report prints.
 *
 * @param rawCountsByCard - raw `LABEL_NAME` → plays, per card, pre-resolution
 * @param resolutions - the surviving verdicts, in any order
 */
export function summarize(
  rawCountsByCard: ReadonlyMap<number, ReadonlyMap<string, number>>,
  resolutions: readonly CardResolution[]
): ResolutionSummary {
  const rawVariantDistribution = new Map<number, number>();
  let cardsSingleValuedRaw = 0;
  for (const counts of rawCountsByCard.values()) {
    const n = counts.size;
    rawVariantDistribution.set(n, (rawVariantDistribution.get(n) ?? 0) + 1);
    if (n === 1) cardsSingleValuedRaw++;
  }

  const groupCountDistribution = new Map<number, number>();
  const distinct = new Set<string>();
  let cardsResolved = 0;
  for (const r of resolutions) {
    const n = r.groups.length;
    groupCountDistribution.set(n, (groupCountDistribution.get(n) ?? 0) + 1);
    if (r.status === 'resolved') {
      cardsResolved++;
      if (r.resolvedLabel !== null) distinct.add(r.resolvedLabel);
    }
  }

  return {
    cardsWithAnyRawLabel: rawCountsByCard.size,
    cardsSingleValuedRaw,
    cardsAfterNormalization: resolutions.length,
    cardsResolved,
    cardsConflicted: resolutions.length - cardsResolved,
    groupCountDistribution,
    rawVariantDistribution,
    distinctResolvedLabels: distinct.size,
  };
}
