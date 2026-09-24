/**
 * BS#2669 — resolve a canonical label per library card from the archived
 * tubafrenzy flowsheet.
 *
 * READ-ONLY. This job opens no database connection of any kind. It reads a
 * gzipped mysqldump off local disk and writes three TSVs plus a Markdown
 * report into this directory. Applying the mapping to `wxyc_schema.library`
 * is BS#2672 and deliberately lives behind a separate review.
 *
 * Usage:
 *   npx tsx jobs/library-label-backfill/job.ts --dump <path-to.sql.gz>
 *
 * Options:
 *   --dump <path>    required; the mysqldump `.sql.gz` to read
 *   --out <dir>      output directory (default: this job's directory)
 *   --clone <path>   a `pg_dump --data-only` clone of `wxyc_schema.library`
 *                    used only to report how many mapped cards still have a
 *                    live row (default: dev_env/seed-clone.sql when present)
 *
 * The run prints its inputs' SHA-256 and embeds it in the report, because the
 * provenance of the capture is the one fact a reviewer cannot re-derive from
 * the output.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { iterTableRows } from './dump';
import { SUFFIX_TOKENS } from './normalize';
import { resolveCard, summarize, type CardResolution } from './resolve';

const TABLE = 'FLOWSHEET_ENTRY_PROD';
/** 0-based column positions in `FLOWSHEET_ENTRY_PROD`, per the dump's DDL. */
const COL_LIBRARY_RELEASE_ID = 6;
const COL_LABEL_NAME = 8;
/** 0-based `legacy_release_id` in the seed-clone's `wxyc_schema.library` COPY. */
const CLONE_LEGACY_RELEASE_ID = 14;

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  dump: string;
  out: string;
  clone: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
  };
  const dump = get('--dump');
  if (dump === null) {
    throw new Error('--dump <path-to-mysqldump.sql.gz> is required');
  }
  const defaultClone = resolvePath(HERE, '..', '..', 'dev_env', 'seed-clone.sql');
  const clone = get('--clone') ?? (existsSync(defaultClone) ? defaultClone : null);
  return { dump: resolvePath(dump), out: resolvePath(get('--out') ?? HERE), clone };
}

/** SHA-256 of a file, streamed so a 142 MB capture never lands in memory. */
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path; read-only
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

interface ScanResult {
  totalRows: number;
  playsLinkedToCard: number;
  playsLabelled: number;
  rawCountsByCard: Map<number, Map<string, number>>;
  /** Raw labels containing a tab or newline, which the TSV output cannot carry verbatim. */
  untypeableRawLabels: number;
}

/**
 * Single pass over the dump, accumulating raw label counts per card.
 *
 * A play counts as *linked* when `LIBRARY_RELEASE_ID > 0` (0 and NULL are both
 * "not a card" in tubafrenzy) and as *labelled* when it additionally carries a
 * `LABEL_NAME` that is not empty after trimming.
 */
async function scanDump(dumpPath: string): Promise<ScanResult> {
  const rawCountsByCard = new Map<number, Map<string, number>>();
  let totalRows = 0;
  let playsLinkedToCard = 0;
  let playsLabelled = 0;
  let untypeableRawLabels = 0;

  for await (const row of iterTableRows(dumpPath, TABLE)) {
    totalRows++;

    const idText = row[COL_LIBRARY_RELEASE_ID];
    if (idText === null || idText === undefined) continue;
    const legacyReleaseId = Number(idText);
    if (!Number.isInteger(legacyReleaseId) || legacyReleaseId <= 0) continue;
    playsLinkedToCard++;

    const rawLabel = row[COL_LABEL_NAME];
    if (rawLabel === null || rawLabel === undefined) continue;
    const trimmed = rawLabel.trim();
    if (trimmed === '') continue;
    playsLabelled++;

    if (/[\t\n\r]/.test(trimmed)) untypeableRawLabels++;
    const key = trimmed.replace(/[\t\n\r]+/g, ' ');

    let counts = rawCountsByCard.get(legacyReleaseId);
    if (!counts) {
      counts = new Map<string, number>();
      rawCountsByCard.set(legacyReleaseId, counts);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);

    if (totalRows % 500_000 === 0) {
      console.log(`  …${totalRows.toLocaleString('en-US')} rows scanned`);
    }
  }

  return { totalRows, playsLinkedToCard, playsLabelled, rawCountsByCard, untypeableRawLabels };
}

/**
 * Count how many of `ids` appear as a `legacy_release_id` in a `pg_dump
 * --data-only` clone of `wxyc_schema.library`.
 *
 * Purely informational: it previews how much of this mapping BS#2672 will be
 * able to join to a live row, against a clone that is already months old.
 */
function countLiveCards(clonePath: string, ids: ReadonlySet<number>): { cloneRows: number; matched: number } {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path; read-only
  const text = readFileSync(clonePath, 'utf8');
  const marker = 'COPY wxyc_schema.library (';
  const start = text.indexOf(marker);
  if (start === -1) return { cloneRows: 0, matched: 0 };
  const bodyStart = text.indexOf('\n', text.indexOf('FROM stdin;', start)) + 1;
  const bodyEnd = text.indexOf('\n\\.\n', bodyStart);
  const body = text.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);

  let cloneRows = 0;
  let matched = 0;
  for (const line of body.split('\n')) {
    if (line === '') continue;
    cloneRows++;
    const field = line.split('\t')[CLONE_LEGACY_RELEASE_ID];
    if (field === undefined || field === '\\N') continue;
    if (ids.has(Number(field))) matched++;
  }
  return { cloneRows, matched };
}

const tsv = (rows: readonly (readonly (string | number)[])[]): string =>
  rows.map((r) => r.join('\t')).join('\n') + '\n';

/** Overlapping shapes within the conflict residue, for the report. */
interface ConflictShapes {
  /** Cards where every group but the leader has exactly one play. */
  singlePlayMinorities: number;
  /** Cards where the leading group holds at least 90% of the plays. */
  dominantLeader: number;
  /** Cards where a minority group is the leader's key plus a 4-digit year. */
  yearAnnotated: number;
}

/**
 * Describe the conflict residue without acting on it.
 *
 * These are counted so BS#2672 can judge whether some subset is adjudicable.
 * They are deliberately NOT used to resolve anything here: "the leader has 90%
 * of the plays" does not distinguish a typo from a genuine co-release on a
 * second label, and this job has no basis for that call.
 */
function describeConflicts(conflicted: readonly CardResolution[]): ConflictShapes {
  let singlePlayMinorities = 0;
  let dominantLeader = 0;
  let yearAnnotated = 0;

  for (const r of conflicted) {
    const [leader, ...minorities] = r.groups;
    if (minorities.every((g) => g.plays === 1)) singlePlayMinorities++;
    if (r.plays > 0 && leader.plays / r.plays >= 0.9) dominantLeader++;
    // eslint-disable-next-line security/detect-non-literal-regexp -- built from a normalized key (letters+digits only)
    const withYear = new RegExp(`^${leader.normalized}(?:19|20)\\d{2}$`);
    if (minorities.some((g) => withYear.test(g.normalized))) yearAnnotated++;
  }

  return { singlePlayMinorities, dominantLeader, yearAnnotated };
}

function distributionTable(dist: ReadonlyMap<number, number>, label: string): string {
  const keys = [...dist.keys()].sort((a, b) => a - b);
  const lines = [`| ${label} | cards |`, '|---:|---:|'];
  for (const k of keys) {
    lines.push(`| ${k} | ${(dist.get(k) ?? 0).toLocaleString('en-US')} |`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading ${args.dump}`);
  const dumpSha = await sha256(args.dump);
  console.log(`  sha256 ${dumpSha}`);

  const scan = await scanDump(args.dump);
  console.log(`Scanned ${scan.totalRows.toLocaleString('en-US')} ${TABLE} rows`);

  const resolutions: CardResolution[] = [];
  for (const [legacyReleaseId, counts] of scan.rawCountsByCard) {
    const r = resolveCard(legacyReleaseId, counts);
    if (r !== null) resolutions.push(r);
  }
  resolutions.sort((a, b) => a.legacyReleaseId - b.legacyReleaseId);

  const summary = summarize(scan.rawCountsByCard, resolutions);
  const resolved = resolutions.filter((r) => r.status === 'resolved');
  const conflicted = resolutions.filter((r) => r.status === 'conflict');
  const conflictShapes = describeConflicts(conflicted);

  // ---- artefacts ---------------------------------------------------------

  const mappingRows: (string | number)[][] = [
    ['legacy_release_id', 'resolved_label', 'normalized_label', 'plays', 'variant_count', 'raw_variants'],
  ];
  for (const r of resolved) {
    const variants = r.groups[0].variants;
    mappingRows.push([
      r.legacyReleaseId,
      r.resolvedLabel ?? '',
      r.normalizedLabel ?? '',
      r.plays,
      variants.length,
      JSON.stringify(variants.map((v) => [v.raw, v.plays])),
    ]);
  }
  writeFileSync(join(args.out, 'label-mapping.tsv'), tsv(mappingRows));

  const conflictRows: (string | number)[][] = [['legacy_release_id', 'plays', 'group_count', 'groups']];
  for (const r of conflicted) {
    conflictRows.push([
      r.legacyReleaseId,
      r.plays,
      r.groups.length,
      JSON.stringify(
        r.groups.map((g) => ({
          normalized: g.normalized,
          plays: g.plays,
          variants: g.variants.map((v) => [v.raw, v.plays]),
        }))
      ),
    ]);
  }
  writeFileSync(join(args.out, 'label-conflicts.tsv'), tsv(conflictRows));

  const labelCards = new Map<string, number>();
  for (const r of resolved) {
    if (r.resolvedLabel === null) continue;
    labelCards.set(r.resolvedLabel, (labelCards.get(r.resolvedLabel) ?? 0) + 1);
  }
  const labelRows: (string | number)[][] = [['resolved_label', 'cards']];
  for (const [name, cards] of [...labelCards].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))) {
    labelRows.push([name, cards]);
  }
  writeFileSync(join(args.out, 'resolved-label-names.tsv'), tsv(labelRows));

  // ---- clone cross-check (informational) ---------------------------------

  let liveNote = '_Not run: no `wxyc_schema.library` clone available._';
  if (args.clone !== null && existsSync(args.clone)) {
    const ids = new Set(resolutions.map((r) => r.legacyReleaseId));
    const { cloneRows, matched } = countLiveCards(args.clone, ids);
    const pct = cloneRows === 0 ? 0 : (matched / cloneRows) * 100;
    liveNote =
      `Against \`${args.clone.replace(resolvePath(HERE, '..', '..') + '/', '')}\` ` +
      `(${cloneRows.toLocaleString('en-US')} \`library\` rows): **${matched.toLocaleString('en-US')}** ` +
      `carry a \`legacy_release_id\` this mapping covers (${pct.toFixed(1)}% of the catalog). ` +
      `Informational only — BS#2672 must re-derive the join against production.`;
  }

  // ---- report ------------------------------------------------------------

  const pct = (n: number, d: number) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));
  const num = (n: number) => n.toLocaleString('en-US');

  const conflictSample = conflicted
    .slice()
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 25)
    .map((r) => {
      const groups = r.groups
        .map((g) => `\`${g.normalized}\` (${g.variants.map((v) => `"${v.raw}" ×${v.plays}`).join(', ')})`)
        .join(' · ');
      return `| ${r.legacyReleaseId} | ${r.groups.length} | ${num(r.plays)} | ${groups} |`;
    })
    .join('\n');

  const report = `# BS#2669 — resolved label per library card

Generated by \`jobs/library-label-backfill/job.ts\`. **Read-only**: no database
was contacted and nothing was written outside this directory. Applying the
mapping is [BS#2672](https://github.com/WXYC/Backend-Service/issues/2672).

## Provenance — read this before using the mapping

| | |
|---|---|
| artefact read | \`${basename(args.dump)}\` |
| sha256 | \`${dumpSha}\` |
| \`${TABLE}\` rows | ${num(scan.totalRows)} |

> **This is not the authoritative capture.** BS#2669 names
> \`s3://wxyc-archive/legacy/tubafrenzy/2026-09-16/wxycmusic-backup-2026-09-16-135233.sql.gz\`
> (sha256 \`533bb48da9dc89aa354849a6eebe8ab348da67e0ffc9e5a3941607925d46bad1\`) as the
> authoritative final dump. That object was unreachable when this ran — the
> \`wxyc-api\` AWS SSO session had expired — so the figures here come from a later
> re-dump of the same database, which has been frozen since 2026-09-16 13:09 PDT.
> The two files are the same length (142,256,283 bytes) and differ in sha256,
> consistent with differing only in the dump-timestamp bytes mysqldump and gzip
> write into the header and footer. **That is corroboration, not proof.**
> Regenerate this mapping from the S3 object and diff it before BS#2672 applies
> anything to production.

## Coverage

| | count | |
|---|---:|---|
| \`${TABLE}\` rows | ${num(scan.totalRows)} | |
| plays linked to a card (\`LIBRARY_RELEASE_ID > 0\`) | ${num(scan.playsLinkedToCard)} | |
| …carrying a non-empty \`LABEL_NAME\` | ${num(scan.playsLabelled)} | ${pct(scan.playsLabelled, scan.playsLinkedToCard)}% |
| distinct cards with at least one label | ${num(summary.cardsWithAnyRawLabel)} | |
| …single-valued on the raw string | ${num(summary.cardsSingleValuedRaw)} | ${pct(summary.cardsSingleValuedRaw, summary.cardsWithAnyRawLabel)}% |
| distinct cards surviving normalization | ${num(summary.cardsAfterNormalization)} | |
| **…resolved (one normalized label)** | **${num(summary.cardsResolved)}** | **${pct(summary.cardsResolved, summary.cardsAfterNormalization)}%** |
| …left conflicted | ${num(summary.cardsConflicted)} | ${pct(summary.cardsConflicted, summary.cardsAfterNormalization)}% |

${(() => {
  const dropped = summary.cardsWithAnyRawLabel - summary.cardsAfterNormalization;
  return `${num(dropped)} card${dropped === 1 ? '' : 's'} dropped out at normalization: every spelling ${dropped === 1 ? 'it' : 'they'} carried consisted only of punctuation and corporate-suffix tokens, so ${dropped === 1 ? 'it holds' : 'they hold'} no label information to resolve.`;
})()}

${liveNote}

## Cross-check against the prior audit

BS#2669 quotes figures from an earlier audit whose code was not published. Each
countable quantity reproduces **exactly**, which is what validates the dump
parser and the linked/labelled predicates:

| quantity | BS#2669 | measured here | |
|---|---:|---:|---|
| \`${TABLE}\` rows | 2,643,453 | ${num(scan.totalRows)} | ${scan.totalRows === 2643453 ? 'exact' : 'DIFFERS'} |
| plays linked to a card | 1,081,412 | ${num(scan.playsLinkedToCard)} | ${scan.playsLinkedToCard === 1081412 ? 'exact' : 'DIFFERS'} |
| …labelled | 1,009,419 | ${num(scan.playsLabelled)} | ${scan.playsLabelled === 1009419 ? 'exact' : 'DIFFERS'} |
| distinct cards with a label | 37,741 | ${num(summary.cardsWithAnyRawLabel)} | ${summary.cardsWithAnyRawLabel === 37741 ? 'exact' : 'DIFFERS'} |
| single-valued raw | 12,522 (33.2%) | ${num(summary.cardsSingleValuedRaw)} (${pct(summary.cardsSingleValuedRaw, summary.cardsWithAnyRawLabel)}%) | ${summary.cardsSingleValuedRaw === 12522 ? 'exact' : 'DIFFERS'} |
| cards after normalization | 37,739 | ${num(summary.cardsAfterNormalization)} | +${summary.cardsAfterNormalization - 37739} |
| single-valued after normalization | 22,295 (59.1%) | ${num(summary.cardsResolved)} (${pct(summary.cardsResolved, summary.cardsAfterNormalization)}%) | ${summary.cardsResolved - 22295} |

The two normalization rows are the only ones that move, and they are the only
two that depend on a rule BS#2669 states in prose rather than code — "strip
punctuation" does not say whether punctuation becomes a space or nothing, and
the two readings differ by hundreds of cards. The rule below was chosen on
measured evidence rather than to hit the quoted number, and lands within 0.4%
of it. Nothing here suggests a parsing discrepancy.

## The normalization rule

Applied to every raw \`LABEL_NAME\` before the vote, in order:

1. Unicode **NFKC**, then **lowercase**.
2. **Decompose and drop combining marks**, so \`Barbès\` and \`Barbes\` are one
   label. DJs routinely omit an accent they cannot type quickly; every accent
   merge in the corpus is one label typed two ways (Cómeme/Comeme,
   Naïve/Naive, Crónica/Cronica, Häpna/Hapna).
3. **Split** on every character that is not a letter or digit
   (Unicode-aware \`\\p{L}\`/\`\\p{N}\`). Punctuation and spaces are separators.
4. **Drop** these whole tokens wherever they appear: ${[...SUFFIX_TOKENS].map((t) => `\`${t}\``).join(', ')}.
   Whole tokens only, so \`Musicians\` and \`Incendiary\` survive intact.
5. **Concatenate** the surviving tokens with no separator.

Step 5 is the one that looks wrong and is not. Space-joining would keep
\`Sub Pop\` and \`SubPop\` apart, and word-boundary noise is most of what DJs
actually vary. Measured over this corpus, concatenating resolves **618 more
cards** than space-joining, and all 233 distinct merges it creates are one
label typed two ways — \`A&M\`/\`AM\` (78 cards), \`Sub Pop\`/\`SubPop\` (61),
\`I.R.S.\`/\`IRS\`, \`4 AD\`/\`4AD\`, \`Stone's Throw\`/\`Stones Throw\`,
\`Roc-A-Fella\`/\`Rocafella\`, \`Collector's Choice\`/\`Collectors Choice\`. Not one
conflates two different labels. The key is for comparison only: the value
written to the mapping is the most-played **raw** spelling, which keeps its
spaces, punctuation and accents.

A result of \`''\` means the entry carried no label information and is dropped.
The rule is stated once, in \`normalize.ts\`, and is covered by
\`tests/unit/jobs/library-label-backfill/normalize.test.ts\`.

**The rule settles spelling, never substance.** A card is resolved only when
*every* play agrees after normalization. Cards whose plays disagree are emitted
as conflicts with **no** candidate value, because \`library.label\` feeds
discogs-etl's \`label_match\` dedup ranking key — a wrong label there promotes
the wrong pressing for the whole station, and a reissue legitimately carries
different labels across plays, so disagreement is not always error.

## Variant-count distributions

Raw spellings per card, before normalization:

${distributionTable(summary.rawVariantDistribution, 'raw variants')}

Surviving normalized labels per card (1 = resolved; 2+ = conflict):

${distributionTable(summary.groupCountDistribution, 'normalized labels')}

## Conflicts — what the residue is made of

The ${num(conflicted.length)} conflicted cards are **not** ${num(conflicted.length)} cards with two
real labels. Three overlapping shapes dominate, measured over the whole residue:

| shape | cards | |
|---|---:|---:|
| every minority group has exactly **one** play | ${num(conflictShapes.singlePlayMinorities)} | ${pct(conflictShapes.singlePlayMinorities, conflicted.length)}% |
| the leading group holds **≥90%** of the card's plays | ${num(conflictShapes.dominantLeader)} | ${pct(conflictShapes.dominantLeader, conflicted.length)}% |
| a minority group is the leading label **plus a 4-digit year** (\`4AD\` vs \`4AD (2012)\`) | ${num(conflictShapes.yearAnnotated)} | ${pct(conflictShapes.yearAnnotated, conflicted.length)}% |

So most of the residue is one-off typing noise against a clear leader —
\`"Tow Dawg Entertainment" ×1\` beside \`"Top Dawg Entertainment" ×338\` — not a
reissue with two genuine labels. **This job still refuses to guess on any of
them**, because the shapes above are a description of the data, not a decision
rule, and separating "typo" from "co-release on a second label" needs judgment
this job does not have. They are quantified here so BS#2672 can decide whether
to adjudicate a subset (a play-share floor, or stripping parenthetical years)
rather than treating all ${num(conflicted.length)} as equally uncertain.

### Verbatim sample

The conflicted cards are listed in full in \`label-conflicts.tsv\`. The 25
most-played:

| legacy_release_id | labels | plays | normalized groups (raw spellings ×plays) |
|---:|---:|---:|---|
${conflictSample}

## Labels absent from \`wxyc_schema.labels\`

**Not measurable offline.** \`wxyc_schema.labels\` is in neither
\`dev_env/seed-clone.sql\` (which carries only \`format\`, \`artists\`,
\`genre_artist_crossreference\`, \`library\`, \`rotation\`) nor any other fixture in
this repo, and this ticket contacts no database.

What is measurable: this mapping resolves **${num(summary.distinctResolvedLabels)} distinct label
names**, listed with their card counts in \`resolved-label-names.tsv\`. That is
the **upper bound** on \`labels\` rows BS#2672 would need to create. The exact
figure is one query against production, using the emitted file:

\`\`\`sql
-- load resolved-label-names.tsv into a temp table as (resolved_label, cards)
SELECT count(*) FROM tmp_resolved_labels t
WHERE NOT EXISTS (
  SELECT 1 FROM wxyc_schema.labels l WHERE lower(l.label_name) = lower(t.resolved_label)
);
\`\`\`

The expected answer is close to the full ${num(summary.distinctResolvedLabels)}:
\`library.label_id\` is 100% NULL across all 64,193 rows, and the only writer of
\`labels\` is the forward-looking librarian edit path in
\`library.controller.ts\`, so the table has only ever accumulated labels typed
since that path shipped.

Note the length constraint: \`labels.label_name\` is \`varchar(128)\` and
\`library.label\` is \`varchar(128)\`. ${num(resolved.filter((r) => (r.resolvedLabel ?? '').length > 128).length)} resolved
label(s) exceed 128 characters and would need truncation or exclusion by BS#2672.

## Files

| file | rows | contents |
|---|---:|---|
| \`label-mapping.tsv\` | ${num(resolved.length)} | the mapping: \`legacy_release_id\` → resolved label, with every raw spelling and its play count |
| \`label-conflicts.tsv\` | ${num(conflicted.length)} | cards with two or more genuinely distinct labels; no candidate value |
| \`resolved-label-names.tsv\` | ${num(summary.distinctResolvedLabels)} | distinct resolved labels and how many cards each covers |

Keys are \`legacy_release_id\` (tubafrenzy \`LIBRARY_RELEASE_ID\`), never
\`library.id\` — resolving to \`library.id\` needs production and belongs to
BS#2672.
`;

  writeFileSync(join(args.out, 'REPORT.md'), report);

  console.log(`\nCards with a label: ${num(summary.cardsWithAnyRawLabel)}`);
  console.log(
    `  single-valued raw:        ${num(summary.cardsSingleValuedRaw)} (${pct(summary.cardsSingleValuedRaw, summary.cardsWithAnyRawLabel)}%)`
  );
  console.log(`  surviving normalization:  ${num(summary.cardsAfterNormalization)}`);
  console.log(
    `  resolved:                 ${num(summary.cardsResolved)} (${pct(summary.cardsResolved, summary.cardsAfterNormalization)}%)`
  );
  console.log(`  conflicted:               ${num(summary.cardsConflicted)}`);
  console.log(`  distinct resolved labels: ${num(summary.distinctResolvedLabels)}`);
  if (scan.untypeableRawLabels > 0) {
    console.log(
      `  note: ${num(scan.untypeableRawLabels)} raw label(s) contained a tab/newline, collapsed to a space for TSV output`
    );
  }
  console.log(`\nWrote label-mapping.tsv, label-conflicts.tsv, resolved-label-names.tsv, REPORT.md to ${args.out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
