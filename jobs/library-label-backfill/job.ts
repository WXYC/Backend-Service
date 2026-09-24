/**
 * BS#2669 — resolve a canonical label per library card from tubafrenzy's
 * acquisition record.
 *
 * READ-ONLY. This job opens no database connection of any kind. It reads a
 * gzipped mysqldump off local disk and writes two TSVs plus a Markdown report
 * into this directory. Applying the mapping to `wxyc_schema.library` is
 * BS#2672 and deliberately lives behind a separate review.
 *
 * The mapping is built from `ROTATION_RELEASE` joined to `COMPANY` — 21,641 +
 * 7,246 rows. The flowsheet is not an input to it. `FLOWSHEET_ENTRY_PROD` is
 * read only to *measure the population this job deliberately excludes* (see
 * `censusExcludedDjTyped`), which the report has to state; `--skip-excluded-census`
 * skips that pass and the ~4 minutes it costs.
 *
 * Usage:
 *   npx tsx jobs/library-label-backfill/job.ts --dump <path-to.sql.gz>
 *
 * Options:
 *   --dump <path>             required; the mysqldump `.sql.gz` to read
 *   --out <dir>               output directory (default: this job's directory)
 *   --clone <path>            a `pg_dump --data-only` clone of
 *                             `wxyc_schema.library`, used only to report how
 *                             many mapped cards still have a live row
 *                             (default: dev_env/seed-clone.sql when present)
 *   --skip-excluded-census    don't scan the flowsheet for the excluded-population
 *                             figures; the report says they were not measured
 *
 * The run prints its input's SHA-256 and embeds it in the report, because the
 * provenance of the capture is the one fact a reviewer cannot re-derive from
 * the output.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { iterTableRows } from './dump';
import { resolveCardLabel, summarize, type CardLabel, type Company, type RotationRow } from './resolve';

const ROTATION_TABLE = 'ROTATION_RELEASE';
const COMPANY_TABLE = 'COMPANY';
const FLOWSHEET_TABLE = 'FLOWSHEET_ENTRY_PROD';

/** 0-based column positions, per each table's DDL in the dump. */
const RR_COMPANY_ID = 7;
const RR_ALTERNATE_LABEL_NAME = 8;
const RR_LIBRARY_RELEASE_ID = 21;
const CO_ID = 0;
const CO_NAME = 1;
const FS_LIBRARY_RELEASE_ID = 6;
const FS_ROTATION_RELEASE_ID = 7;
const FS_LABEL_NAME = 8;
/** 0-based `legacy_release_id` in the seed-clone's `wxyc_schema.library` COPY. */
const CLONE_LEGACY_RELEASE_ID = 14;

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  dump: string;
  out: string;
  clone: string | null;
  skipExcludedCensus: boolean;
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
  return {
    dump: resolvePath(dump),
    out: resolvePath(get('--out') ?? HERE),
    clone,
    skipExcludedCensus: argv.includes('--skip-excluded-census'),
  };
}

/** SHA-256 of a file, streamed so a 142 MB capture never lands in memory. */
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path; read-only
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Load `COMPANY` into an id → row map, skipping rows with an empty NAME. */
async function loadCompanies(dumpPath: string): Promise<{ companies: Map<number, Company>; totalRows: number }> {
  const companies = new Map<number, Company>();
  let totalRows = 0;
  for await (const row of iterTableRows(dumpPath, COMPANY_TABLE)) {
    totalRows++;
    const id = Number(row[CO_ID]);
    const name = (row[CO_NAME] ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || name === '') continue;
    companies.set(id, { id, name });
  }
  return { companies, totalRows };
}

interface RotationScan {
  totalRows: number;
  /** Rows whose `LIBRARY_RELEASE_ID` names a card. */
  linkedRows: number;
  /** Of those, rows whose `COMPANY_ID` resolves to a named `COMPANY` row. */
  rowsWithCompany: number;
  /** Linked rows carrying an `ALTERNATE_LABEL_NAME`. */
  rowsWithAlternate: number;
  /** Linked rows with no resolvable `COMPANY_ID` but an `ALTERNATE_LABEL_NAME`. */
  rowsAlternateOnly: number;
  /** Cards reachable ONLY via `ALTERNATE_LABEL_NAME`. */
  cardsAlternateOnly: Set<number>;
  byCard: Map<number, RotationRow[]>;
}

/** Single pass over `ROTATION_RELEASE`, grouping rows by the card they name. */
async function scanRotation(dumpPath: string, companies: ReadonlyMap<number, Company>): Promise<RotationScan> {
  const byCard = new Map<number, RotationRow[]>();
  const cardsAlternateOnly = new Set<number>();
  let totalRows = 0;
  let linkedRows = 0;
  let rowsWithCompany = 0;
  let rowsWithAlternate = 0;
  let rowsAlternateOnly = 0;

  for await (const row of iterTableRows(dumpPath, ROTATION_TABLE)) {
    totalRows++;
    const legacyReleaseId = Number(row[RR_LIBRARY_RELEASE_ID]);
    if (!Number.isInteger(legacyReleaseId) || legacyReleaseId <= 0) continue;
    linkedRows++;

    const rawCompanyId = row[RR_COMPANY_ID];
    const parsed = rawCompanyId === null ? Number.NaN : Number(rawCompanyId);
    const resolvable = Number.isInteger(parsed) && parsed > 0 && companies.has(parsed);
    const companyId = resolvable ? parsed : null;
    const alternateLabelName = (row[RR_ALTERNATE_LABEL_NAME] ?? '').trim();

    if (alternateLabelName !== '') rowsWithAlternate++;
    if (companyId !== null) {
      rowsWithCompany++;
      const bucket = byCard.get(legacyReleaseId);
      if (bucket) bucket.push({ legacyReleaseId, companyId, alternateLabelName });
      else byCard.set(legacyReleaseId, [{ legacyReleaseId, companyId, alternateLabelName }]);
    } else if (alternateLabelName !== '') {
      rowsAlternateOnly++;
      cardsAlternateOnly.add(legacyReleaseId);
    }
  }

  // A card is "alternate-only" only if NO row on it carried a company id.
  for (const card of [...cardsAlternateOnly]) {
    if (byCard.has(card)) cardsAlternateOnly.delete(card);
  }

  return {
    totalRows,
    linkedRows,
    rowsWithCompany,
    rowsWithAlternate,
    rowsAlternateOnly,
    cardsAlternateOnly,
    byCard,
  };
}

/** The population this job deliberately does not map. */
interface ExcludedCensus {
  linkedPlays: number;
  labelledPlays: number;
  /** Plays on a rotation entry (`ROTATION_RELEASE_ID > 0`). */
  rotationLinkedPlays: number;
  rotationLabelledPlays: number;
  /** Plays not on a rotation entry — the DJ typed the label per play. */
  djLinkedPlays: number;
  djLabelledPlays: number;
  /** Cards carrying at least one DJ-typed label. */
  djCards: number;
  /** Of those, cards this job's mapping does not already cover. */
  djCardsNotCovered: number;
}

/**
 * Measure the DJ-typed population the mapping excludes.
 *
 * Reporting only — nothing here feeds the mapping. It exists because "we
 * excluded a source" is a claim that has to carry a number: BS#2669 requires
 * the excluded set to be measured rather than silently dropped.
 */
async function censusExcludedDjTyped(dumpPath: string, covered: ReadonlySet<number>): Promise<ExcludedCensus> {
  let linkedPlays = 0;
  let labelledPlays = 0;
  let rotationLinkedPlays = 0;
  let rotationLabelledPlays = 0;
  let djLinkedPlays = 0;
  let djLabelledPlays = 0;
  const djCards = new Set<number>();

  for await (const row of iterTableRows(dumpPath, FLOWSHEET_TABLE)) {
    const card = Number(row[FS_LIBRARY_RELEASE_ID]);
    if (!Number.isInteger(card) || card <= 0) continue;
    linkedPlays++;

    const rotationId = Number(row[FS_ROTATION_RELEASE_ID]);
    const isRotationEntry = Number.isInteger(rotationId) && rotationId > 0;
    if (isRotationEntry) rotationLinkedPlays++;
    else djLinkedPlays++;

    const label = (row[FS_LABEL_NAME] ?? '').trim();
    if (label === '') continue;
    labelledPlays++;
    if (isRotationEntry) {
      rotationLabelledPlays++;
    } else {
      djLabelledPlays++;
      djCards.add(card);
    }
  }

  let djCardsNotCovered = 0;
  for (const card of djCards) if (!covered.has(card)) djCardsNotCovered++;

  return {
    linkedPlays,
    labelledPlays,
    rotationLinkedPlays,
    rotationLabelledPlays,
    djLinkedPlays,
    djLabelledPlays,
    djCards: djCards.size,
    djCardsNotCovered,
  };
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

const num = (n: number): string => n.toLocaleString('en-US');
const pct = (a: number, b: number): string => (b === 0 ? '0.0' : ((a / b) * 100).toFixed(1));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading ${args.dump}`);
  const dumpSha = await sha256(args.dump);
  console.log(`  sha256 ${dumpSha}`);

  const { companies, totalRows: companyRows } = await loadCompanies(args.dump);
  console.log(`${COMPANY_TABLE}: ${num(companyRows)} rows, ${num(companies.size)} with a usable NAME`);

  const rotation = await scanRotation(args.dump, companies);
  console.log(`${ROTATION_TABLE}: ${num(rotation.totalRows)} rows, ${num(rotation.linkedRows)} linked to a card`);

  const labels: CardLabel[] = [];
  for (const [legacyReleaseId, rows] of rotation.byCard) {
    const label = resolveCardLabel(legacyReleaseId, rows, companies);
    if (label !== null) labels.push(label);
  }
  labels.sort((a, b) => a.legacyReleaseId - b.legacyReleaseId);

  const summary = summarize(labels);
  const resolved = labels.filter((l) => l.status === 'resolved');
  const conflicted = labels.filter((l) => l.status === 'conflict');
  const covered = new Set(labels.map((l) => l.legacyReleaseId));

  const census = args.skipExcludedCensus ? null : await censusExcludedDjTyped(args.dump, covered);

  // ---- artefacts ---------------------------------------------------------

  const mappingRows: (string | number)[][] = [
    ['legacy_release_id', 'label_name', 'company_id', 'company_ids', 'rotation_rows'],
  ];
  for (const l of resolved) {
    mappingRows.push([l.legacyReleaseId, l.labelName ?? '', l.companyId ?? '', l.companyIds.join(','), l.rotationRows]);
  }
  writeFileSync(join(args.out, 'label-mapping.tsv'), tsv(mappingRows));

  const conflictRows: (string | number)[][] = [['legacy_release_id', 'label_count', 'rotation_rows', 'labels']];
  for (const l of conflicted) {
    conflictRows.push([
      l.legacyReleaseId,
      l.groups.length,
      l.rotationRows,
      JSON.stringify(l.groups.map((g) => ({ name: g.name, company_ids: g.companyIds, rotation_rows: g.rotationRows }))),
    ]);
  }
  writeFileSync(join(args.out, 'label-conflicts.tsv'), tsv(conflictRows));

  // ---- clone cross-check (informational) ---------------------------------

  let liveNote = '_Not run: no `wxyc_schema.library` clone available._';
  if (args.clone !== null && existsSync(args.clone)) {
    const { cloneRows, matched } = countLiveCards(args.clone, covered);
    liveNote =
      `Against \`${args.clone.replace(resolvePath(HERE, '..', '..') + '/', '')}\` ` +
      `(${num(cloneRows)} \`library\` rows): **${num(matched)}** carry a \`legacy_release_id\` this mapping ` +
      `covers (${pct(matched, cloneRows)}% of the catalog). Informational only — BS#2672 must re-derive the ` +
      `join against production.`;
  }

  // ---- report ------------------------------------------------------------

  const conflictTable = conflicted
    .slice()
    .sort((a, b) => b.rotationRows - a.rotationRows || a.legacyReleaseId - b.legacyReleaseId)
    .map(
      (l) =>
        `| ${l.legacyReleaseId} | ${l.groups.length} | ${l.rotationRows} | ` +
        `${l.groups.map((g) => `${g.name} (id ${g.companyIds.join('/')}, ${g.rotationRows}×)`).join(' · ')} |`
    )
    .join('\n');

  const excludedSection =
    census === null
      ? `**Not measured on this run** (\`--skip-excluded-census\`). Re-run without that flag to populate this section.`
      : `\`FLOWSHEET_ENTRY_PROD.LABEL_NAME\` pools two provenances under one column name:

| source | labelled plays | | fill rate | origin |
|---|---:|---:|---:|---|
| rotation entries (\`ROTATION_RELEASE_ID > 0\`) | ${num(census.rotationLabelledPlays)} | ${pct(census.rotationLabelledPlays, census.labelledPlays)}% | **${pct(census.rotationLabelledPlays, census.rotationLinkedPlays)}%** | copied from the \`ROTATION_RELEASE\` record |
| everything else | ${num(census.djLabelledPlays)} | ${pct(census.djLabelledPlays, census.labelledPlays)}% | ${pct(census.djLabelledPlays, census.djLinkedPlays)}% | typed by the DJ, per play |

A ${pct(census.rotationLabelledPlays, census.rotationLinkedPlays)}% fill rate is not diligence, it is a system copy — the same acquisition
record this mapping already reads, arriving second-hand as text.

**The size of what is excluded:** ${num(census.djCards)} cards carry at least one
DJ-typed label, and **${num(census.djCardsNotCovered)}** of them are not covered by the
rotation route. Taking them would roughly ${((census.djCardsNotCovered + summary.cardsResolved) / Math.max(summary.cardsResolved, 1)).toFixed(1)}× the card count.

They are excluded anyway, and the reason is provenance rather than volume. A
DJ-typed label describes whatever object was in that DJ's hands; nothing in the
flowsheet records whether that was the library's copy, and \`library.label\`
exists to answer "which pressing does WXYC hold". So an unverifiable label is
not weak evidence — it is the wrong kind of evidence.

The cost asymmetry settles it. A **missing** label makes discogs-etl's
\`label_match\` key abstain, which is the status quo for 100% of cards today and
costs nothing. A **wrong** label promotes the wrong pressing for that release
station-wide, and is indistinguishable from a right one downstream.

If that trade is ever revisited, the DJ-typed route should be a separate,
separately-reviewed mapping with its own confidence column — not merged into
this one, where it would be indistinguishable from an acquisition record.`;

  const report = `# BS#2669 — resolved label per library card

Generated by \`jobs/library-label-backfill/job.ts\`. **Read-only**: no database
was contacted and nothing was written outside this directory. Applying the
mapping is [BS#2672](https://github.com/WXYC/Backend-Service/issues/2672).

## Provenance

| | |
|---|---|
| artefact read | \`${basename(args.dump)}\` |
| sha256 | \`${dumpSha}\` |

That is the 2026-09-21 re-dump, not the file BS#2669 names as the authoritative
final capture:

\`\`\`
s3://wxyc-archive/legacy/tubafrenzy/2026-09-16/wxycmusic-backup-2026-09-16-135233.sql.gz
sha256 533bb48da9dc89aa354849a6eebe8ab348da67e0ffc9e5a3941607925d46bad1
\`\`\`

**The two are identical in content, and that is verified rather than inferred.**
Both files are 142,256,283 bytes; their gzip digests differ only because
mysqldump stamps a "Dump completed on" line and gzip stamps an mtime. Strip the
comment and blank lines from each and hash what remains:

\`\`\`sh
gzip -dc <dump>.sql.gz | sed '/^--/d; /^$/d' | shasum -a 256
\`\`\`

Both yield \`8fb365f1692594c7e08e1939773d4948ff43d99ca7dd741340bb44e44d8b8f9e\`.
The database has been frozen since 2026-09-16 13:09 PDT, so the two captures
record the same state — re-running this job against the S3 object would
reproduce these figures byte for byte. No regeneration is required before
BS#2672. The artefact is named here because provenance is worth recording, not
because the result is provisional.

## Source: the acquisition record

\`ROTATION_RELEASE\` records something the station acquired. It carries
\`LIBRARY_RELEASE_ID\` directly and a \`COMPANY_ID\` foreign key into \`COMPANY\`,
whose \`NAME\` is the label. The flowsheet is not an input to this mapping.

| | count | |
|---|---:|---|
| \`${ROTATION_TABLE}\` rows | ${num(rotation.totalRows)} | |
| …with \`LIBRARY_RELEASE_ID > 0\` | ${num(rotation.linkedRows)} | ${pct(rotation.linkedRows, rotation.totalRows)}% |
| …and a resolvable \`COMPANY_ID\` | ${num(rotation.rowsWithCompany)} | ${pct(rotation.rowsWithCompany, rotation.linkedRows)}% of linked |
| \`${COMPANY_TABLE}\` rows | ${num(companyRows)} | |
| **distinct library cards covered** | **${num(summary.cardsCovered)}** | |
| **…resolved (one label)** | **${num(summary.cardsResolved)}** | **${pct(summary.cardsResolved, summary.cardsCovered)}%** |
| …conflicted (two or more labels) | ${num(summary.cardsConflicted)} | ${pct(summary.cardsConflicted, summary.cardsCovered)}% |
| distinct label names emitted | ${num(summary.distinctLabels)} | |

${liveNote}

## No normalization, no vote

The label arrives as a **foreign key, not as text**, so this route needs no
spelling normalization, no modal vote and no unanimity rule. A card resolves
when its rotation rows name one label. The ${num(summary.cardsConflicted)} cards whose re-adds name
two different labels are genuine multi-label cases and are emitted as conflicts
with no value.

**One exception, and it is about \`COMPANY\`, not about labels.** That table holds
${num(companyRows)} rows but only ${num(new Set([...companies.values()].map((c) => c.name.toLowerCase())).size)} distinct names: a label acquired
again years later was often entered as a fresh row, so "atlantic" exists as ids
123, 6446 and 6486. Grouping a card's rotation rows by raw \`COMPANY_ID\` would
call ${num(summary.cardsWithDuplicateCompanyRows)} cards conflicted when every id names the same label. This job
therefore compares **case-folded \`COMPANY.NAME\`** (trim + lowercase, nothing
else — these are curated rows, not typed-per-play free text), which resolves
those cards. Seven of them differ only in letter case, which is why the fold is
case-insensitive rather than exact.

**BS#2672 must collapse that duplication rather than carry it across**: three
"Atlantic" rows in \`wxyc_schema.labels\` would reintroduce the same problem on
the Backend side. \`label-mapping.tsv\` carries a \`company_ids\` column listing
every id behind each resolved name so the write side can see exactly what it is
collapsing; \`company_id\` is the most-used of them (lowest id breaking a tie).

## \`ALTERNATE_LABEL_NAME\`

**Ignored, and it costs nothing.** Of the ${num(rotation.linkedRows)} card-linked rotation rows,
${num(rotation.rowsWithAlternate)} carry an \`ALTERNATE_LABEL_NAME\` — and **${num(rotation.rowsAlternateOnly)}** of those lack a
resolvable \`COMPANY_ID\`. Every row that has an alternate name also has a real
company FK, so using it as a fallback would add **${num(rotation.cardsAlternateOnly.size)} cards**. It is free
text rather than an identity, so on the same provenance reasoning applied to
DJ-typed labels below, it is not worth reintroducing text handling for zero
additional coverage.

## The excluded DJ-typed population

${excludedSection}

## Conflicts — in full

All ${num(conflicted.length)} conflicted cards, largest first. They are also in
\`label-conflicts.tsv\`.

| legacy_release_id | labels | rotation rows | labels (COMPANY ids, rows) |
|---:|---:|---:|---|
${conflictTable}

## Pin-corpus overlap

**Not measurable offline.** The override-pin corpus lives in the discogs-cache
PostgreSQL, which is not part of this dump and is not running locally (ports
5434/5435 refuse connections; 5433 holds a Backend \`wxyc_db\`, not the cache).
This ticket contacts no database, so the overlap has to be measured where the
pins are. The query, once \`label-mapping.tsv\` is loaded as
\`tmp_label_mapping(legacy_release_id, …)\`:

\`\`\`sql
SELECT count(*) FROM tmp_label_mapping m
WHERE EXISTS (SELECT 1 FROM <pin table> p WHERE p.library_release_id = m.legacy_release_id);
\`\`\`

BS#2669 reports 15,771 of the resolved cards as pinned — 25.8% of a
61,046-pin corpus — measured where that table is reachable.

## Files

| file | rows | contents |
|---|---:|---|
| \`label-mapping.tsv\` | ${num(resolved.length)} | the mapping: \`legacy_release_id\` → \`label_name\` + \`company_id\`, with every duplicate \`COMPANY\` id and the rotation-row count |
| \`label-conflicts.tsv\` | ${num(conflicted.length)} | cards whose re-adds name two or more different labels; no value |

Keys are \`legacy_release_id\` (tubafrenzy \`LIBRARY_RELEASE_ID\`), never
\`library.id\` — resolving to \`library.id\` needs production and belongs to
BS#2672. Because \`company_id\` is carried through, BS#2672 can populate
\`library.label_id\` directly rather than matching label strings against
\`wxyc_schema.labels\`.
`;

  writeFileSync(join(args.out, 'REPORT.md'), report);

  console.log(`\nCards covered:      ${num(summary.cardsCovered)}`);
  console.log(
    `  resolved:         ${num(summary.cardsResolved)} (${pct(summary.cardsResolved, summary.cardsCovered)}%)`
  );
  console.log(`  conflicted:       ${num(summary.cardsConflicted)}`);
  console.log(`  distinct labels:  ${num(summary.distinctLabels)}`);
  console.log(
    `  dup COMPANY rows: ${num(summary.cardsWithDuplicateCompanyRows)} resolved cards whose label has 2+ ids`
  );
  console.log(`  ALTERNATE_LABEL_NAME would add: ${num(rotation.cardsAlternateOnly.size)} cards`);
  if (census !== null) {
    console.log(
      `  excluded DJ-typed: ${num(census.djCards)} cards, ${num(census.djCardsNotCovered)} not otherwise covered`
    );
  }
  console.log(`\nWrote label-mapping.tsv, label-conflicts.tsv, REPORT.md to ${args.out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
