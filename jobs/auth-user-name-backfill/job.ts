/**
 * One-shot backfill: rewrite `auth_user.name` to the value it should always
 * have held — the on-air handle, else `username` — so the column stops
 * being a hidden second copy of the legal name.
 *
 * DJ real-name PII safeguards plan, Track 2d. The runtime counterpart to
 * Track 2b's `databaseHooks.user` before-hooks (`shared/authentication/src/
 * derive-user-display-name.ts`): those hooks stop the leak from growing on
 * every future write; this job repairs the ~139 rows that predate them.
 *
 * DRY-RUN IS THE DEFAULT, matching `jobs/flowsheet-ghost-row-sweep`'s
 * convention (not `jobs/legacy-dj-name-remediation`'s inverted one): the
 * container reports what it would change with zero writes; pass `--execute`
 * to write.
 *
 *   docker run --rm --env-file .env <image>            # dry-run
 *   docker run --rm --env-file .env <image> --execute   # writes
 *
 * Opens with a MACHINE-ENFORCED PRECONDITION GATE (see decide.ts's
 * `violatesPreserveFirstPrecondition`) that aborts non-zero — in both
 * dry-run and execute mode — if any row still holds its only copy of a
 * legal name in `name`. That means Track 2a's preserve-first copy
 * (`name -> real_name`, reviewed manual SQL) has not run against this
 * database; the gate makes run order irrelevant instead of trusting an
 * operator to sequence 2a before 2d correctly.
 *
 * The non-anonymous rows are read in a single SELECT (see `fetchAllUsers`'s
 * docblock for why anonymous rows are filtered out at the query) and the
 * decision is computed IN-PROCESS via the canonical `resolveDjDisplayName`
 * helper, then written back only for rows that differ. `auth_user`'s
 * non-anonymous slice is small (~139 candidate rows out of the whole
 * roster) — the batching / id-cursor machinery `flowsheet-dj-name-backfill`
 * needs for a many-million-row table would be unneeded complexity here.
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';
import { decideAuthUserNameBackfill, violatesPreserveFirstPrecondition, type AuthUserBackfillRow } from './decide.js';

const JOB_NAME = 'auth-user-name-backfill';

/**
 * `--execute` opts into writing; the default (and `--dry-run`, spelled out
 * explicitly) reports without touching the database. Throws on contradictory
 * flags rather than silently picking one, mirroring
 * flowsheet-ghost-row-sweep's `resolveDryRun`.
 */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

type RawUserRow = {
  id: string;
  name: string;
  username: string | null;
  dj_name: string | null;
  real_name: string | null;
  is_anonymous: boolean | null;
};

/**
 * The one read this job performs. No LIMIT — see the module doc for why
 * that's fine here (a single small table, ~139 candidate rows).
 *
 * WHERE excludes anonymous per-device rows (FINDING 7, BS#2297 review).
 * `decideAuthUserNameBackfill` and `runPreconditionGate` already skip
 * `is_anonymous` rows unconditionally, so this is behavior-identical — it
 * just stops pulling them (and everyone's `real_name`) into process memory
 * to be immediately discarded. Anonymous rows plausibly dominate
 * `auth_user`; there's no reason to load legal names for rows this job
 * never writes to.
 */
export const fetchAllUsers = async (): Promise<AuthUserBackfillRow[]> => {
  const rows = (await db.execute(sql`
    SELECT "id", "name", "username", "dj_name", "real_name", "is_anonymous"
    FROM "auth_user"
    WHERE "is_anonymous" IS DISTINCT FROM true
  `)) as unknown as RawUserRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    username: r.username,
    djName: r.dj_name,
    realName: r.real_name,
    isAnonymous: r.is_anonymous ?? false,
  }));
};

/**
 * Abort non-zero (throw) if any row still relies on `auth_user.name` as its
 * only copy of a legal name. Runs against the SAME rows the backfill loop
 * below computes decisions from — one SELECT does double duty as both the
 * gate's input and the backfill's input.
 */
export const runPreconditionGate = (rows: AuthUserBackfillRow[]): void => {
  const violations = rows.filter(violatesPreserveFirstPrecondition);
  if (violations.length === 0) return;

  const sampleIds = violations.slice(0, 10).map((r) => r.id);
  throw new Error(
    `[${JOB_NAME}] Refusing to run: ${violations.length} row(s) hold their ONLY copy of a legal name in ` +
      `auth_user.name (real_name is blank, name is not 'Anonymous'/'Auto DJ'/username, and name is not the ` +
      `on-air handle). This means Track 2a of the DJ real-name PII safeguards plan (the reviewed manual SQL ` +
      'that copies name -> real_name) has not run against this database. Run 2a first, then re-run this job. ' +
      `Sample id(s): ${sampleIds.join(', ')}` +
      (violations.length > sampleIds.length ? ', ...' : '')
  );
};

/** Write path for a single decided row. Raw SQL, not the query builder — this job bypasses better-auth's hooks entirely (a direct data repair, not a user-facing write). */
export const applyUpdate = async (id: string, name: string): Promise<void> => {
  await db.execute(sql`
    UPDATE "auth_user"
    SET "name" = ${name}, "updated_at" = now()
    WHERE "id" = ${id}
  `);
};

export interface BackfillSummary {
  scanned: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
}

export const runBackfill = async (opts: { dryRun: boolean }): Promise<BackfillSummary> => {
  console.log(`[${JOB_NAME}] Starting. dry_run=${opts.dryRun}`);

  const rows = await fetchAllUsers();
  console.log(`[${JOB_NAME}] Loaded ${rows.length} auth_user row(s).`);

  runPreconditionGate(rows);
  console.log(
    `[${JOB_NAME}] Precondition gate passed: no row still relies on auth_user.name as its only legal-name copy.`
  );

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const decision = decideAuthUserNameBackfill(row);
    if (decision === undefined) {
      skipped += 1;
      continue;
    }
    console.log(
      `[${JOB_NAME}] ${opts.dryRun ? '[dry-run] would update' : 'updating'} id=${row.id} name: ${JSON.stringify(row.name)} -> ${JSON.stringify(decision)}`
    );
    if (!opts.dryRun) {
      await applyUpdate(row.id, decision);
    }
    updated += 1;
  }

  const summary: BackfillSummary = { scanned: rows.length, updated, skipped, dryRun: opts.dryRun };
  console.log(
    `[${JOB_NAME}] Done. scanned=${summary.scanned} updated=${summary.updated} skipped=${summary.skipped} dry_run=${summary.dryRun}`
  );
  return summary;
};

const main = async () => {
  try {
    const dryRun = resolveDryRun();
    await runBackfill({ dryRun });
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});
