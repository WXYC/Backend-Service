#!/usr/bin/env node

/**
 * Interactive provisioner for the migrate-dryrun workflow's AWS prereqs.
 *
 * The migrate-dryrun job in `.github/workflows/test.yml` restores the
 * latest prod RDS snapshot to an ephemeral sandbox, runs Drizzle's
 * migrate against it, then tears the sandbox down. It needs four
 * things provisioned out-of-band, all flagged in CLAUDE.md and called
 * out by WXYC/Backend-Service#726 / #756:
 *
 *   1. IAM policy granting the GHA user a narrow set of RDS actions
 *      plus prefix-list read/modify on PLs tagged
 *      `wxyc:purpose=gha-egress`.
 *   2. N managed prefix list shards (`wxyc-gha-egress-{1..N}`, default
 *      N=5, each capacity 1000) populated with the GitHub Actions
 *      egress IPv4 CIDRs from api.github.com/meta. Re-synced weekly
 *      by sync-gha-prefix-list.yml. Sharding is required because AWS
 *      hard-caps a single PL at 1000 entries while the aggregated GHA
 *      IPv4 set is ~3300 entries (each PL ref counts as 1 SG rule, so
 *      5 shards fits comfortably under the default 60-rule SG limit).
 *   3. A security group with one tcp/5432 ingress rule per shard
 *      (rather than inlining individual CIDRs, which can't fit in any
 *      single PL — see #756 for the failure mode).
 *   4. Five GitHub repo secrets the workflow reads.
 *
 * This script walks you through all four, idempotently. Every step
 * checks whether the change already exists before applying it, and
 * persists progress to .dryrun-provisioning-state.json so an
 * interruption (Ctrl+C, network blip, AWS throttle, transient gh CLI
 * auth issue) can be resumed without redoing earlier steps.
 *
 * Usage:
 *   node scripts/provision-dryrun-aws.mjs               # interactive
 *   node scripts/provision-dryrun-aws.mjs --status      # print state, exit
 *   node scripts/provision-dryrun-aws.mjs --reset       # wipe state, start over
 *   node scripts/provision-dryrun-aws.mjs --dry-run     # print actions, don't execute
 *   node scripts/provision-dryrun-aws.mjs --yes         # skip per-step confirmations
 *
 * Flags compose: e.g. --dry-run --yes prints every action with no
 * prompting. Useful for capturing the planned change-set in a review
 * comment before running for real.
 *
 * Re-run policy: re-running after a successful pass is a no-op (every
 * phase short-circuits). Re-running after a partial failure picks up
 * at the first incomplete phase. Use --reset only when you want to
 * deliberately throw away the recorded state and start fresh; this
 * does NOT undo AWS changes already made — for that, see the manual
 * teardown instructions printed by --status when state exists.
 */

import { execFileSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { createInterface } from 'readline/promises';
import { stdin, stdout, stderr, exit } from 'process';

// ---- constants ------------------------------------------------------------

const AWS_ACCOUNT = '203767826763';
const AWS_REGION = 'us-east-1';
const POLICY_NAME = 'wxyc-gha-rds-dryrun';
const SG_NAME = 'wxyc-dryrun-gha';
const PREFIX_LIST_NAME_PREFIX = 'wxyc-gha-egress';
const PREFIX_LIST_SHARDS = 5;
const PREFIX_LIST_MAX_ENTRIES = 1000; // AWS hard cap per PL; we shard to fit ~3300 aggregated GHA IPv4 CIDRs.
const PREFIX_LIST_TAG_KEY = 'wxyc:purpose';
const PREFIX_LIST_TAG_VALUE = 'gha-egress';
const PREFIX_LIST_NAMES = Array.from({ length: PREFIX_LIST_SHARDS }, (_, i) => `${PREFIX_LIST_NAME_PREFIX}-${i + 1}`);
const REPO = 'WXYC/Backend-Service';
const STATE_FILE = '.dryrun-provisioning-state.json';
const SECRET_NAMES = ['PROD_DB_ID', 'PROD_DB_NAME', 'PROD_DB_USERNAME', 'PROD_DB_PASSWORD', 'SG_DRYRUN_GHA'];

/**
 * Build the IAM policy document. The EC2 prefix-list actions are
 * scoped to PLs in this account+region tagged `wxyc:purpose=gha-egress`,
 * which the provisioner stamps on every shard at create time. This
 * covers all N shards in one statement without baking shard ARNs into
 * the policy. Describe* APIs don't accept resource conditions, so
 * DescribeManagedPrefixLists keeps Resource: "*".
 */
function buildIamPolicyDocument() {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DescribeReadOnly',
        Effect: 'Allow',
        Action: ['rds:DescribeDBSnapshots', 'rds:DescribeDBInstances', 'ec2:DescribeManagedPrefixLists'],
        Resource: '*',
      },
      {
        Sid: 'RestoreFromProdSnapshot',
        Effect: 'Allow',
        Action: 'rds:RestoreDBInstanceFromDBSnapshot',
        Resource: [
          `arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT}:db:dryrun-*`,
          `arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT}:snapshot:*`,
          `arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT}:subgrp:*`,
          `arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT}:pg:*`,
          `arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT}:og:*`,
        ],
      },
      {
        Sid: 'ManageSandboxOnly',
        Effect: 'Allow',
        Action: ['rds:DeleteDBInstance', 'rds:AddTagsToResource'],
        Resource: `arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT}:db:dryrun-*`,
      },
      {
        Sid: 'SyncGhaPrefixList',
        Effect: 'Allow',
        Action: ['ec2:GetManagedPrefixListEntries', 'ec2:ModifyManagedPrefixList'],
        Resource: `arn:aws:ec2:${AWS_REGION}:${AWS_ACCOUNT}:prefix-list/*`,
        Condition: {
          StringEquals: { [`aws:ResourceTag/${PREFIX_LIST_TAG_KEY}`]: PREFIX_LIST_TAG_VALUE },
        },
      },
    ],
  };
}

// ---- args -----------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const FLAG = {
  status: args.has('--status'),
  reset: args.has('--reset'),
  dryRun: args.has('--dry-run'),
  yes: args.has('--yes'),
  help: args.has('--help') || args.has('-h'),
};

if (FLAG.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
  exit(0);
}

// ---- console formatting ---------------------------------------------------

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const heading = (s) => console.log('\n' + c.bold(c.cyan(`━━ ${s} ━━`)));
const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const skip = (s) => console.log(`  ${c.dim('•')} ${c.dim(s)}`);
const info = (s) => console.log(`  ${c.blue('→')} ${s}`);
const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);
const fail = (s) => console.error(`  ${c.red('✗')} ${s}`);

// ---- shell wrappers -------------------------------------------------------

class CmdError extends Error {
  constructor(cmd, exitCode, stderr, stdout) {
    super(`${cmd[0]} exited ${exitCode}: ${stderr.trim() || stdout.trim() || '(no output)'}`);
    this.cmd = cmd;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/**
 * Run a command and return stdout. Throws CmdError on non-zero exit.
 *
 * `mutating` flag: when --dry-run is set, mutating commands are printed
 * instead of executed. Read-only commands (describe-*, list-*) always
 * run, even under --dry-run, so we can determine current state.
 */
function run(cmd, { mutating = false, input = null, hideEcho = false } = {}) {
  if (mutating && FLAG.dryRun) {
    console.log(`  ${c.dim('[dry-run]')} ${c.dim(cmd.join(' '))}`);
    return '';
  }
  if (!hideEcho) {
    // Echo describe/read-only commands quietly so the operator can see
    // what's being asked of AWS / gh. Mutating commands get a louder
    // banner before they run (printed by the caller).
  }
  const result = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    input: input ?? undefined,
  });
  if (result.error) {
    throw new CmdError(cmd, -1, result.error.message, '');
  }
  if (result.status !== 0) {
    throw new CmdError(cmd, result.status, result.stderr || '', result.stdout || '');
  }
  return (result.stdout || '').trim();
}

// Active AWS profile, set by preflight after we discover which (if any)
// profile points at the WXYC prod account. All aws() calls thread it
// through as --profile <name> so the operator doesn't have to remember
// to export AWS_PROFILE in their shell.
let activeAwsProfile = null;

const aws = (args, opts) => {
  const fullArgs = activeAwsProfile ? ['--profile', activeAwsProfile, ...args] : args;
  return run(['aws', ...fullArgs], opts);
};
const awsJson = (args, opts) => JSON.parse(aws(args, opts) || 'null');
const gh = (args, opts) => run(['gh', ...args], opts);

/**
 * Probe a specific AWS profile (or the default if name is null) and
 * return its caller identity, or null if it errors. Doesn't mutate
 * activeAwsProfile.
 */
function probeAwsProfile(name) {
  const profileArgs = name ? ['--profile', name] : [];
  try {
    return JSON.parse(run(['aws', ...profileArgs, 'sts', 'get-caller-identity', '--output', 'json']));
  } catch {
    return null;
  }
}

/**
 * Find a profile whose caller identity is in AWS_ACCOUNT. Tries the
 * current default first (so users already pointed at prod don't get
 * an extra prompt), then iterates through configured profiles.
 *
 * Returns { profile: string | null, identity: object } where profile=null
 * means "use the default — it already points at prod." Returns null
 * outright when nothing in the local config can reach prod.
 */
function findWxycProfile() {
  // Default credentials: env-var, instance-profile, or default profile.
  const defaultId = probeAwsProfile(null);
  if (defaultId && defaultId.Account === AWS_ACCOUNT) {
    return { profile: null, identity: defaultId };
  }

  // Enumerate profiles. Catches sso-only setups too — list-profiles
  // surfaces them, sts probe will work if the SSO session is still
  // valid (otherwise just falls through to the next profile).
  let profiles;
  try {
    profiles = run(['aws', 'configure', 'list-profiles']).split('\n').filter(Boolean);
  } catch {
    profiles = [];
  }

  const matches = [];
  for (const name of profiles) {
    const id = probeAwsProfile(name);
    if (id && id.Account === AWS_ACCOUNT) matches.push({ profile: name, identity: id });
  }
  return { matches, defaultIdentity: defaultId };
}

// ---- state persistence ----------------------------------------------------

function loadState() {
  if (!existsSync(STATE_FILE)) return { version: 1, started_at: new Date().toISOString(), phases: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed.version !== 1) {
      throw new Error(`unrecognized state file version ${parsed.version}; expected 1`);
    }
    return parsed;
  } catch (e) {
    fail(`Could not parse ${STATE_FILE}: ${e.message}`);
    fail(`Move it aside and re-run, or use --reset to wipe.`);
    exit(2);
  }
}

function saveState(state) {
  // Under --dry-run, never persist state. Otherwise the dry-run would
  // record phases as "done" and a follow-up real run would skip the
  // mutations it was supposed to apply. Dry-run is for previewing —
  // it must leave no trace.
  if (FLAG.dryRun) return;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function resetState() {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

// ---- prompts --------------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout, terminal: stdout.isTTY });

async function ask(question, { defaultValue = null, secret = false } = {}) {
  if (FLAG.yes) {
    // --yes: auto-accept the default, even if the default is empty
    // (downstream prompts handle empty values explicitly). For
    // secrets, refuse to fabricate a value out of thin air.
    if (secret && !defaultValue) {
      fail(`--yes: secret prompt "${question}" has no default and cannot be auto-accepted.`);
      throw new Error('secret prompt with no default under --yes');
    }
    return defaultValue || '';
  }
  const prompt = defaultValue ? `${question} [${defaultValue}] ` : `${question} `;
  const answer = (await rl.question(prompt)).trim();
  return answer || defaultValue || '';
}

async function askYesNo(question, { defaultYes = true } = {}) {
  if (FLAG.yes) return true;
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await rl.question(question + suffix)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

async function askChoice(question, choices, defaultIdx = 0) {
  console.log(question);
  choices.forEach((choice, i) => {
    const marker = i === defaultIdx ? c.bold('▶') : ' ';
    console.log(`  ${marker} ${i + 1}. ${choice.label}`);
    if (choice.detail) console.log(`       ${c.dim(choice.detail)}`);
  });
  if (FLAG.yes) {
    info(`--yes: auto-selecting "${choices[defaultIdx].label}"`);
    return choices[defaultIdx];
  }
  while (true) {
    const answer = (await rl.question(`Choice [${defaultIdx + 1}]: `)).trim();
    if (!answer) return choices[defaultIdx];
    const n = parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
    fail(`Not a valid choice. Pick 1..${choices.length}.`);
  }
}

/**
 * Prompt for a secret without echoing input. Falls back to plain input
 * with a warning when stdin isn't a TTY (e.g. piped in CI).
 */
async function askSecret(question) {
  if (!stdin.isTTY) {
    warn(`stdin is not a TTY; cannot hide input.`);
    return await ask(question);
  }
  process.stdout.write(question + ' ');
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      const ch = chunk.toString('utf8');
      const code = ch.charCodeAt(0);
      if (ch === '\n' || ch === '\r') {
        stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buf);
      } else if (code === 3) {
        // Ctrl+C — restore terminal and exit with conventional code
        stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(130);
      } else if (code === 8 || code === 127) {
        // Backspace / Delete
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else if (code >= 0x20) {
        // Printable; ignore other control characters silently
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---- preflight ------------------------------------------------------------

async function preflight(state) {
  heading('Preflight');

  if (state.phases.preflight) {
    skip(`already done at ${state.phases.preflight.completed_at}`);
    return;
  }

  for (const tool of ['aws', 'gh', 'curl', 'jq']) {
    try {
      run([tool, '--version']);
      ok(`${tool} found`);
    } catch {
      fail(`${tool} not found in PATH. Install it and re-run.`);
      exit(2);
    }
  }

  // Find a credential set that points at the WXYC prod account. Tries
  // the default first (so users already configured for prod don't get
  // an extra prompt), then enumerates named profiles. This avoids the
  // "switch your shell's AWS_PROFILE then re-run" friction — if the
  // operator has the right profile configured, we just use it.
  const probe = findWxycProfile();

  let chosenProfile = null;
  let identity = null;

  if (probe.profile === null && probe.identity) {
    chosenProfile = null;
    identity = probe.identity;
    ok(`AWS account ${AWS_ACCOUNT} via default credentials (caller: ${identity.Arn})`);
  } else if (probe.matches && probe.matches.length === 1) {
    chosenProfile = probe.matches[0].profile;
    identity = probe.matches[0].identity;
    ok(`Found WXYC prod profile "${chosenProfile}" (caller: ${identity.Arn})`);
  } else if (probe.matches && probe.matches.length > 1) {
    info(`Multiple profiles point at account ${AWS_ACCOUNT}. Pick one:`);
    const choice = await askChoice(
      'Which profile should this run use?',
      probe.matches.map((m) => ({
        label: `${m.profile} (${m.identity.Arn})`,
        value: m.profile,
        identity: m.identity,
      }))
    );
    chosenProfile = choice.value;
    identity = choice.identity;
  } else {
    // Nothing local reaches prod. Print actionable guidance.
    fail(`No AWS profile found pointing at account ${AWS_ACCOUNT}.`);
    if (probe.defaultIdentity) {
      fail(`Default credentials are in account ${probe.defaultIdentity.Account} instead.`);
    } else {
      fail(`Default credentials are unset or expired.`);
    }
    fail(``);
    fail(`Fix one of:`);
    fail(`  1. Configure a new profile:  aws configure --profile wxyc`);
    fail(`     then re-run this script.`);
    fail(`  2. If you already have one under a different name:`);
    fail(`        aws configure list-profiles`);
    fail(`        aws sts get-caller-identity --profile <name>`);
    fail(`     then re-run; the script will detect it automatically.`);
    fail(`  3. SSO: refresh the session with  aws sso login --profile <name>`);
    exit(2);
  }

  // Lock the profile in for the rest of the run. All subsequent aws()
  // calls thread it through as --profile.
  activeAwsProfile = chosenProfile;

  let ghStatus;
  try {
    ghStatus = run(['gh', 'auth', 'status'], {});
  } catch (e) {
    fail(`gh auth status failed: ${e.stderr || e.message}`);
    fail(`Run \`gh auth login\` and re-run.`);
    exit(2);
  }
  ok(`gh CLI authenticated`);

  // Confirm gh can see the target repo (write scope is implicit if they
  // can already write to it via PRs; we'll find out for sure on the
  // first secret-set call).
  try {
    gh(['repo', 'view', REPO, '--json', 'name']);
    ok(`gh can see ${REPO}`);
  } catch (e) {
    fail(`gh repo view ${REPO} failed: ${e.stderr || e.message}`);
    exit(2);
  }

  state.phases.preflight = {
    completed_at: new Date().toISOString(),
    aws_account: identity.Account,
    aws_arn: identity.Arn,
    aws_profile: chosenProfile, // null = default credentials
    aws_region: AWS_REGION,
    gh_status_excerpt: ghStatus.split('\n').slice(0, 3).join(' | '),
  };
  saveState(state);
}

/**
 * On a resumed run we already passed preflight, but `activeAwsProfile`
 * is module-local and got reset to null when the process restarted.
 * Re-hydrate it from the state file before any phase calls aws().
 */
function rehydrateAwsProfile(state) {
  if (state.phases.preflight && state.phases.preflight.aws_profile) {
    activeAwsProfile = state.phases.preflight.aws_profile;
  }
}

// ---- IAM ------------------------------------------------------------------

async function iamDecision(state) {
  heading('IAM: pick the user to attach the policy to');

  if (state.phases.iam_decision) {
    skip(`choice already recorded: ${state.phases.iam_decision.choice}`);
    return state.phases.iam_decision.choice;
  }

  const choice = await askChoice('Where should the wxyc-gha-rds-dryrun policy live?', [
    {
      label: 'Attach to existing deploy-user',
      detail: 'Simplest. Matches CLAUDE.md. Mixes deploy and dryrun perms on one user.',
      value: 'deploy-user',
    },
    {
      label: 'Create dedicated gha-dryrun-user',
      detail: 'Cleaner blast radius. Requires you to mint an access key and update GH secrets.',
      value: 'gha-dryrun-user',
    },
  ]);

  state.phases.iam_decision = { choice: choice.value, decided_at: new Date().toISOString() };
  saveState(state);
  return choice.value;
}

async function iamPolicy(state) {
  heading('IAM: create or look up wxyc-gha-rds-dryrun policy');

  const desired = buildIamPolicyDocument();
  const desiredJson = JSON.stringify(desired);

  // Even when state says we've already created the policy in a prior
  // run, re-check the document so subsequent runs that bumped the
  // template (e.g. adding the prefix-list statement in #756) upgrade it
  // in place rather than silently keeping the older version.
  const expectedArn = `arn:aws:iam::${AWS_ACCOUNT}:policy/${POLICY_NAME}`;
  let exists = false;
  try {
    awsJson(['iam', 'get-policy', '--policy-arn', expectedArn, '--output', 'json']);
    exists = true;
  } catch (e) {
    if (!/NoSuchEntity/.test(e.stderr)) throw e;
  }

  if (exists) {
    info(`Found existing policy at ${expectedArn}`);
    const versions = awsJson(['iam', 'list-policy-versions', '--policy-arn', expectedArn, '--output', 'json']);
    const defaultVer = versions.Versions.find((v) => v.IsDefaultVersion);
    const live = awsJson([
      'iam',
      'get-policy-version',
      '--policy-arn',
      expectedArn,
      '--version-id',
      defaultVer.VersionId,
      '--output',
      'json',
    ]);
    const liveDoc = JSON.parse(decodeURIComponent(live.PolicyVersion.Document));
    if (JSON.stringify(liveDoc) === desiredJson) {
      ok(`Policy document matches template (version ${defaultVer.VersionId})`);
    } else {
      warn(`Existing policy document differs from desired template.`);
      if (!FLAG.yes && !FLAG.dryRun) {
        console.log(c.dim('Desired document:'));
        console.log(c.dim(JSON.stringify(desired, null, 2)));
        if (!(await askYesNo('Create a new default version with the desired document?'))) {
          throw new Error('aborted by user (policy drift)');
        }
      }
      // IAM caps a managed policy at 5 versions. If we're at the cap,
      // delete the oldest non-default to make room.
      const nondefault = versions.Versions.filter((v) => !v.IsDefaultVersion).sort(
        (a, b) => new Date(a.CreateDate) - new Date(b.CreateDate)
      );
      if (versions.Versions.length >= 5 && nondefault.length) {
        info(`Pruning oldest non-default version ${nondefault[0].VersionId} to make room`);
        aws(['iam', 'delete-policy-version', '--policy-arn', expectedArn, '--version-id', nondefault[0].VersionId], {
          mutating: true,
        });
      }
      aws(
        [
          'iam',
          'create-policy-version',
          '--policy-arn',
          expectedArn,
          '--policy-document',
          desiredJson,
          '--set-as-default',
          '--output',
          'json',
        ],
        { mutating: true }
      );
      ok(`Policy upgraded to new default version`);
    }
  } else {
    info(`Creating policy ${POLICY_NAME}`);
    if (!FLAG.yes && !FLAG.dryRun) {
      console.log(c.dim('Policy document:'));
      console.log(c.dim(JSON.stringify(desired, null, 2)));
      if (!(await askYesNo('Create this policy?'))) throw new Error('aborted by user');
    }
    aws(
      [
        'iam',
        'create-policy',
        '--policy-name',
        POLICY_NAME,
        '--policy-document',
        desiredJson,
        '--description',
        'GitHub Actions migrate-dryrun: restore prod RDS snapshot to ephemeral sandbox; sync wxyc-gha-egress prefix list',
        '--output',
        'json',
      ],
      { mutating: true }
    );
    ok(`Policy created at ${expectedArn}`);
  }

  state.phases.iam_policy = { arn: expectedArn, recorded_at: new Date().toISOString() };
  saveState(state);
  return expectedArn;
}

async function iamUser(state, choice) {
  heading(`IAM: ensure user "${choice}" exists`);

  if (state.phases.iam_user) {
    skip(`user already prepared: ${state.phases.iam_user.username}`);
    return state.phases.iam_user.username;
  }

  if (choice === 'deploy-user') {
    // Just verify it exists; don't create.
    try {
      awsJson(['iam', 'get-user', '--user-name', 'deploy-user', '--output', 'json']);
      ok(`deploy-user exists`);
    } catch (e) {
      fail(`deploy-user not found in IAM: ${e.stderr || e.message}`);
      fail(`Either create it manually first, or rerun with --reset and choose dedicated user.`);
      throw e;
    }
    state.phases.iam_user = { username: 'deploy-user', created: false, recorded_at: new Date().toISOString() };
    saveState(state);
    return 'deploy-user';
  }

  // Dedicated user path: create the user, mint an access key, hand the
  // creds to the operator to update GH secrets manually.
  try {
    awsJson(['iam', 'get-user', '--user-name', choice, '--output', 'json']);
    ok(`User ${choice} already exists`);
  } catch (e) {
    if (!/NoSuchEntity/.test(e.stderr)) throw e;
    info(`Creating user ${choice}`);
    aws(['iam', 'create-user', '--user-name', choice, '--output', 'json'], { mutating: true });
    ok(`Created user ${choice}`);
  }

  // Mint an access key. We do this only if no keys exist on the user;
  // otherwise the operator already has one (and we'd hit the AWS limit
  // of 2 per user).
  const keys = awsJson(['iam', 'list-access-keys', '--user-name', choice, '--output', 'json']);
  if (keys.AccessKeyMetadata.length > 0) {
    warn(`User ${choice} already has ${keys.AccessKeyMetadata.length} access key(s).`);
    warn(`Skipping key creation. Update GH secrets AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY manually if needed.`);
  } else {
    if (!FLAG.yes && !FLAG.dryRun) {
      warn(`Creating an access key for ${choice}.`);
      warn(`The secret is shown ONCE. You must copy it now to update GH secrets.`);
      if (!(await askYesNo('Proceed?'))) throw new Error('aborted by user');
    }
    const key = awsJson(['iam', 'create-access-key', '--user-name', choice, '--output', 'json'], {
      mutating: true,
    });
    if (!FLAG.dryRun) {
      console.log('');
      console.log(c.bold('  ACCESS KEY (copy now):'));
      console.log(`    AccessKeyId:     ${key.AccessKey.AccessKeyId}`);
      console.log(`    SecretAccessKey: ${key.AccessKey.SecretAccessKey}`);
      console.log('');
      warn(`Update GH repo secrets AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with these values.`);
      warn(`Note: this also affects deploy-base.yml, which uses the same secrets. Coordinate the swap.`);
      await ask(c.bold('Press Enter once you have copied them and updated GH secrets...'));
    }
  }

  state.phases.iam_user = { username: choice, created: true, recorded_at: new Date().toISOString() };
  saveState(state);
  return choice;
}

async function iamAttach(state, username, policyArn) {
  heading(`IAM: attach policy to ${username}`);

  if (state.phases.iam_attach) {
    skip(`already attached at ${state.phases.iam_attach.attached_at}`);
    return;
  }

  const attached = awsJson(['iam', 'list-attached-user-policies', '--user-name', username, '--output', 'json']);
  const already = attached.AttachedPolicies.find((p) => p.PolicyArn === policyArn);
  if (already) {
    ok(`Policy already attached to ${username}`);
  } else {
    info(`Attaching ${policyArn} to ${username}`);
    aws(['iam', 'attach-user-policy', '--user-name', username, '--policy-arn', policyArn], { mutating: true });
    ok(`Attached`);
  }

  state.phases.iam_attach = { attached_at: new Date().toISOString(), policy_arn: policyArn, username };
  saveState(state);
}

// ---- Managed prefix list -------------------------------------------------

async function prefixListsCreate(state) {
  heading(`Prefix lists: ensure ${PREFIX_LIST_SHARDS} shards exist`);

  // Re-evaluate every run so missing shards get backfilled (e.g. someone
  // deleted one out-of-band). Idempotent per-shard via name lookup.
  const recorded = state.phases.prefix_lists_create?.shards || [];
  const recordedById = new Map(recorded.map((s) => [s.name, s]));
  const result = [];

  for (const name of PREFIX_LIST_NAMES) {
    const existing = awsJson([
      'ec2',
      'describe-managed-prefix-lists',
      '--filters',
      `Name=prefix-list-name,Values=${name}`,
      '--output',
      'json',
    ]);
    const customer = (existing.PrefixLists || []).filter((p) => p.OwnerId === AWS_ACCOUNT);

    let pl;
    if (customer.length === 1) {
      pl = customer[0];
      // Verify the wxyc:purpose tag is present. Without it, IAM scoping
      // by tag won't grant the sync workflow access.
      const tags = pl.Tags || [];
      const hasTag = tags.some((t) => t.Key === PREFIX_LIST_TAG_KEY && t.Value === PREFIX_LIST_TAG_VALUE);
      if (!hasTag) {
        info(`Tagging existing ${name} (${pl.PrefixListId}) with ${PREFIX_LIST_TAG_KEY}=${PREFIX_LIST_TAG_VALUE}`);
        aws(
          [
            'ec2',
            'create-tags',
            '--resources',
            pl.PrefixListId,
            '--tags',
            `Key=${PREFIX_LIST_TAG_KEY},Value=${PREFIX_LIST_TAG_VALUE}`,
            '--output',
            'json',
          ],
          { mutating: true }
        );
      }
      ok(`${name}: ${pl.PrefixListId} (max ${pl.MaxEntries}, ${pl.State})`);
    } else if (customer.length > 1) {
      fail(`Multiple customer-managed PLs named "${name}". Resolve manually.`);
      throw new Error('ambiguous PL name');
    } else {
      if (!FLAG.yes && !FLAG.dryRun && !recordedById.has(name)) {
        info(`About to create managed PL "${name}" (capacity ${PREFIX_LIST_MAX_ENTRIES}).`);
      }
      const created = awsJson(
        [
          'ec2',
          'create-managed-prefix-list',
          '--prefix-list-name',
          name,
          '--address-family',
          'IPv4',
          '--max-entries',
          String(PREFIX_LIST_MAX_ENTRIES),
          '--tag-specifications',
          `ResourceType=prefix-list,Tags=[{Key=${PREFIX_LIST_TAG_KEY},Value=${PREFIX_LIST_TAG_VALUE}}]`,
          '--output',
          'json',
        ],
        { mutating: true }
      );
      pl = FLAG.dryRun
        ? {
            PrefixListId: `<dry-run-${name}>`,
            PrefixListArn: `arn:aws:ec2:${AWS_REGION}:${AWS_ACCOUNT}:prefix-list/<dry-run>`,
            MaxEntries: PREFIX_LIST_MAX_ENTRIES,
            State: 'create-pending',
          }
        : created.PrefixList;
      ok(`${name}: created ${pl.PrefixListId}`);
    }

    result.push({
      name,
      prefix_list_id: pl.PrefixListId,
      prefix_list_arn: pl.PrefixListArn,
      max_entries: pl.MaxEntries,
    });
  }

  state.phases.prefix_lists_create = {
    shards: result,
    shard_count: PREFIX_LIST_SHARDS,
    created_at: new Date().toISOString(),
  };
  saveState(state);
  return result;
}

async function prefixListBootstrap(state) {
  heading('Prefix lists: populate from api.github.com/meta');

  if (FLAG.dryRun) {
    skip(`--dry-run: would invoke scripts/sync-gha-prefix-list.mjs`);
    return;
  }

  // Always run; sync script is idempotent (no-op when no diff). The
  // recurring weekly workflow keeps it fresh after this bootstrap.
  info(`Invoking scripts/sync-gha-prefix-list.mjs`);
  const env = { ...process.env };
  if (activeAwsProfile) env.AWS_PROFILE = activeAwsProfile;
  const result = spawnSync(
    process.execPath,
    [
      new URL('./sync-gha-prefix-list.mjs', import.meta.url).pathname,
      '--name-prefix',
      PREFIX_LIST_NAME_PREFIX,
      '--shards',
      String(PREFIX_LIST_SHARDS),
    ],
    { stdio: 'inherit', env }
  );
  if (result.status !== 0) {
    throw new Error(`sync-gha-prefix-list.mjs exited ${result.status}`);
  }
  ok(`PLs populated from api.github.com/meta`);

  state.phases.prefix_list_bootstrap = {
    completed_at: new Date().toISOString(),
  };
  saveState(state);
}

// ---- Security Group ------------------------------------------------------

async function sgFindVpc(state) {
  heading('Security Group: find the VPC the prod RDS instance lives in');

  if (state.phases.sg_vpc) {
    skip(`VPC already discovered: ${state.phases.sg_vpc.vpc_id}`);
    return state.phases.sg_vpc;
  }

  // List RDS instances and let the operator pick the prod one. We
  // don't hardcode the identifier so the script works regardless of
  // what the prod instance is named.
  const instances = awsJson(['rds', 'describe-db-instances', '--output', 'json']);
  if (!instances.DBInstances.length) {
    fail(`No RDS instances found in ${AWS_REGION}.`);
    throw new Error('no RDS instances');
  }

  const choices = instances.DBInstances.map((db) => ({
    label: `${db.DBInstanceIdentifier} (${db.Engine} ${db.EngineVersion}, ${db.DBInstanceStatus})`,
    detail: `VPC ${db.DBSubnetGroup.VpcId}, db ${db.DBName || '(none)'}, master ${db.MasterUsername}`,
    instance: db,
  }));

  // Pre-select the first instance that looks like prod (has "prod" in
  // its name, isn't a dryrun-* sandbox).
  let defaultIdx = 0;
  for (let i = 0; i < choices.length; i++) {
    const id = choices[i].instance.DBInstanceIdentifier.toLowerCase();
    if (id.includes('prod') && !id.startsWith('dryrun-')) {
      defaultIdx = i;
      break;
    }
  }

  const picked = await askChoice('Which instance is the prod one?', choices, defaultIdx);
  const vpcId = picked.instance.DBSubnetGroup.VpcId;
  ok(`Selected ${picked.instance.DBInstanceIdentifier} in VPC ${vpcId}`);

  state.phases.sg_vpc = {
    vpc_id: vpcId,
    prod_db_id: picked.instance.DBInstanceIdentifier,
    prod_db_name: picked.instance.DBName || null,
    prod_db_username: picked.instance.MasterUsername,
    discovered_at: new Date().toISOString(),
  };
  saveState(state);
  return state.phases.sg_vpc;
}

async function sgCreate(state, vpcId) {
  heading(`Security Group: create or look up "${SG_NAME}" in ${vpcId}`);

  if (state.phases.sg_create?.sg_id) {
    skip(`SG already at ${state.phases.sg_create.sg_id}`);
    return state.phases.sg_create.sg_id;
  }

  // Look up by name + VPC; AWS allows duplicate names across VPCs but
  // not within one.
  const existing = awsJson([
    'ec2',
    'describe-security-groups',
    '--filters',
    `Name=group-name,Values=${SG_NAME}`,
    `Name=vpc-id,Values=${vpcId}`,
    '--output',
    'json',
  ]);

  let sgId;
  if (existing.SecurityGroups.length > 0) {
    sgId = existing.SecurityGroups[0].GroupId;
    ok(`Found existing SG ${sgId}`);
  } else {
    if (!FLAG.yes && !FLAG.dryRun) {
      info(`About to create SG "${SG_NAME}" in VPC ${vpcId}.`);
      if (!(await askYesNo('Create?'))) throw new Error('aborted by user');
    }
    const created = awsJson(
      [
        'ec2',
        'create-security-group',
        '--group-name',
        SG_NAME,
        '--description',
        'Migrate-dryrun: GitHub Actions ingress to ephemeral RDS sandbox on 5432',
        '--vpc-id',
        vpcId,
        '--output',
        'json',
      ],
      { mutating: true }
    );
    sgId = FLAG.dryRun ? '<dry-run-sg-id>' : created.GroupId;
    ok(`Created SG ${sgId}`);
  }

  state.phases.sg_create = {
    sg_id: sgId,
    sg_name: SG_NAME,
    vpc_id: vpcId,
    created_at: new Date().toISOString(),
  };
  saveState(state);
  return sgId;
}

async function sgIngress(state, sgId, shards) {
  heading(`Security Group: ingress rules reference ${shards.length} prefix list shard(s)`);

  // Inspect current rules on tcp/5432. Two things to do:
  //  - Add a PrefixListIds rule per shard, if missing.
  //  - Revoke any pre-existing inline CIDR rules left over from the
  //    legacy 50-CIDR allowlist (issue #756). These coexist harmlessly,
  //    but having both is misleading — the PLs are the source of truth.
  const current = awsJson(['ec2', 'describe-security-groups', '--group-ids', sgId, '--output', 'json']);
  const perms = current.SecurityGroups[0].IpPermissions || [];

  const presentPlIds = new Set();
  const inlineCidrs = [];
  for (const perm of perms) {
    if (perm.IpProtocol !== 'tcp' || perm.FromPort !== 5432 || perm.ToPort !== 5432) continue;
    for (const pl of perm.PrefixListIds || []) presentPlIds.add(pl.PrefixListId);
    for (const range of perm.IpRanges || []) inlineCidrs.push(range.CidrIp);
  }

  const shardsToAdd = shards.filter((s) => !presentPlIds.has(s.prefix_list_id));
  if (shardsToAdd.length === 0) {
    ok(`All ${shards.length} shard PL rule(s) already present`);
  } else {
    info(`Authorizing ingress on tcp/5432 for ${shardsToAdd.length} shard(s)`);
    // Issue one authorize call covering every missing shard. AWS bundles
    // them into per-shard rule entries server-side; the UI shows them
    // as separate rules.
    aws(
      [
        'ec2',
        'authorize-security-group-ingress',
        '--group-id',
        sgId,
        '--ip-permissions',
        JSON.stringify([
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            PrefixListIds: shardsToAdd.map((s) => ({
              PrefixListId: s.prefix_list_id,
              Description: `GitHub Actions egress shard ${s.name}`,
            })),
          },
        ]),
        '--output',
        'json',
      ],
      { mutating: true }
    );
    ok(`PL ingress rules added for ${shardsToAdd.length} shard(s)`);
  }

  if (inlineCidrs.length) {
    warn(`Found ${inlineCidrs.length} legacy inline CIDR rule(s) on tcp/5432 (pre-#756 allowlist).`);
    let proceed = FLAG.yes;
    if (!FLAG.yes && !FLAG.dryRun) {
      proceed = await askYesNo('Revoke them? The PL rule above already covers GHA runners.');
    }
    if (proceed) {
      info(`Revoking ${inlineCidrs.length} legacy CIDR(s) in batches of 50`);
      const BATCH = 50;
      for (let i = 0; i < inlineCidrs.length; i += BATCH) {
        const batch = inlineCidrs.slice(i, i + BATCH);
        aws(
          [
            'ec2',
            'revoke-security-group-ingress',
            '--group-id',
            sgId,
            '--ip-permissions',
            JSON.stringify([
              {
                IpProtocol: 'tcp',
                FromPort: 5432,
                ToPort: 5432,
                IpRanges: batch.map((cidr) => ({ CidrIp: cidr })),
              },
            ]),
            '--output',
            'json',
          ],
          { mutating: true }
        );
      }
      ok(`Legacy inline CIDRs revoked`);
    } else {
      warn(`Leaving inline CIDRs in place. They're ignored once the PL covers them; re-run to clean up later.`);
    }
  }

  state.phases.sg_ingress = {
    completed: true,
    prefix_list_ids: shards.map((s) => s.prefix_list_id),
    legacy_cidrs_revoked: inlineCidrs.length,
    completed_at: new Date().toISOString(),
  };
  saveState(state);
}

// ---- Repo secrets --------------------------------------------------------

async function listExistingSecrets() {
  // gh secret list outputs lines like "PROD_DB_ID  Updated 2026-..."; we just
  // need the names.
  const out = gh(['secret', 'list', '--repo', REPO]);
  return new Set(
    out
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)
  );
}

async function setSecret(name, value) {
  if (FLAG.dryRun) {
    console.log(`  ${c.dim('[dry-run]')} ${c.dim(`gh secret set ${name} --repo ${REPO}  (value via stdin)`)}`);
    return;
  }
  // Pipe via stdin to avoid the value appearing in argv / process listings.
  // CRITICAL: do NOT pass `--body -` — gh treats that as "the body is the
  // literal string `-`" and ignores stdin entirely. The flag's docs say
  // "reads from standard input if not specified", so omit --body and
  // pass the value via spawnSync's `input`.
  run(['gh', 'secret', 'set', name, '--repo', REPO], { input: value });
}

async function repoSecrets(state) {
  heading('GitHub repo secrets');

  if (state.phases.secrets_set?.completed) {
    skip(`secrets already set: ${Object.keys(state.phases.secrets_set.set || {}).join(', ')}`);
    return;
  }

  const v = state.phases.sg_vpc; // discovery from SG step
  const sgId = state.phases.sg_create.sg_id;

  // Auto-derive defaults from prior state.
  const defaults = {
    PROD_DB_ID: v.prod_db_id,
    PROD_DB_NAME: v.prod_db_name || '',
    PROD_DB_USERNAME: v.prod_db_username,
    PROD_DB_PASSWORD: '',
    SG_DRYRUN_GHA: sgId,
  };

  const existing = await listExistingSecrets();
  for (const name of SECRET_NAMES) {
    if (existing.has(name)) info(`${name}: already set in repo (will overwrite if you provide a new value)`);
    else info(`${name}: not yet set`);
  }

  console.log('');
  warn(
    `For PROD_DB_PASSWORD: this must match the master password on the *snapshot* being restored.\n` +
      `      If prod's password has rotated since automated snapshots started, you may need an\n` +
      `      older password OR a workflow change to add --master-user-password to the restore call.\n` +
      `      Test with one dryrun run before assuming the current prod password works.`
  );

  console.log('');
  const setRecord = {};
  for (const name of SECRET_NAMES) {
    let value;
    if (name === 'PROD_DB_PASSWORD') {
      const skipPw = existing.has(name) && (await askYesNo(`${name} already exists. Keep it?`, { defaultYes: true }));
      if (skipPw) {
        skip(`${name} unchanged`);
        setRecord[name] = 'kept';
        continue;
      }
      if (FLAG.dryRun) {
        // Under --dry-run we never call gh secret set, so we don't
        // need a real password — just a placeholder for the printed
        // command. Skip the prompt entirely (which would block
        // --yes runs that have no TTY).
        value = '<dry-run-placeholder>';
      } else if (FLAG.yes) {
        fail(
          `--yes can't auto-fill PROD_DB_PASSWORD: it has no default. Run interactively or pre-set it via \`gh secret set PROD_DB_PASSWORD\`.`
        );
        throw new Error('PROD_DB_PASSWORD requires interactive input');
      } else {
        value = await askSecret(`${name}:`);
      }
    } else {
      const def = defaults[name];
      value = await ask(`${name}${def ? '' : ' (no default — must enter)'}: `, { defaultValue: def });
      if (!value) {
        warn(`${name}: empty — skipping`);
        setRecord[name] = 'skipped (empty)';
        continue;
      }
    }
    info(`Setting ${name}`);
    await setSecret(name, value);
    setRecord[name] = 'set';
    ok(`${name} written`);
  }

  state.phases.secrets_set = {
    completed: true,
    set: setRecord,
    completed_at: new Date().toISOString(),
  };
  saveState(state);
}

// ---- Verify --------------------------------------------------------------

async function verifySummary(state) {
  heading('Done — summary');

  console.log(`  IAM policy:      ${state.phases.iam_policy?.arn || '(skipped)'}`);
  console.log(`  Attached to:     ${state.phases.iam_attach?.username || '(skipped)'}`);
  const shards = state.phases.prefix_lists_create?.shards || [];
  console.log(
    `  Prefix lists:    ${shards.length} shard(s): ${shards.map((s) => `${s.name}=${s.prefix_list_id}`).join(', ') || '(skipped)'}`
  );
  console.log(
    `  Security group:  ${state.phases.sg_create?.sg_id || '(skipped)'} (${state.phases.sg_create?.sg_name || ''})`
  );
  console.log(`  VPC:             ${state.phases.sg_vpc?.vpc_id || '(skipped)'}`);
  const ingressIds = state.phases.sg_ingress?.prefix_list_ids || [];
  console.log(
    `  Ingress:         ${ingressIds.length ? `${ingressIds.length} PL rule(s)` : '(skipped)'}` +
      (state.phases.sg_ingress?.legacy_cidrs_revoked
        ? ` (${state.phases.sg_ingress.legacy_cidrs_revoked} legacy CIDR(s) revoked)`
        : '')
  );
  console.log(
    `  Repo secrets:    ${Object.entries(state.phases.secrets_set?.set || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`
  );

  console.log('');
  console.log(c.bold('Next steps:'));
  console.log(`  1. Push an empty commit (or just rerun CI) on the PR that touches db-init paths`);
  console.log(`     to trigger the migrate-dryrun job:`);
  console.log(`       ${c.dim('gh pr checks <PR-number> --repo ' + REPO)}`);
  console.log(`  2. Watch the "Migration Dry-Run (prod-shaped data)" job. Steps 1–5:`);
  console.log(`       - Install minimal deps        (already validated)`);
  console.log(`       - Configure AWS credentials   (using deploy-user or new dedicated user)`);
  console.log(`       - Restore latest prod snapshot to ephemeral sandbox  ${c.dim('(3–8 min)')}`);
  console.log(`       - Run \`node scripts/dryrun-migrate.mjs\`             ${c.dim('(actual gate)')}`);
  console.log(`       - Tear down sandbox            ${c.dim('(always-run)')}`);
  console.log(`  3. Cost: ~$0.003 per dryrun run (db.t4g.micro for ~5–10 min). Negligible.`);
  console.log('');
  console.log(c.bold('To undo (rollback):'));
  console.log(`  - Revoke ingress: ${c.dim('aws ec2 revoke-security-group-ingress ...')}`);
  console.log(
    `  - Delete SG:      ${c.dim(`aws ec2 delete-security-group --group-id ${state.phases.sg_create?.sg_id || '<sg>'}`)}`
  );
  console.log(
    `  - Detach policy:  ${c.dim(`aws iam detach-user-policy --user-name ${state.phases.iam_attach?.username || '<user>'} --policy-arn ${state.phases.iam_policy?.arn || '<arn>'}`)}`
  );
  console.log(
    `  - Delete policy:  ${c.dim(`aws iam delete-policy --policy-arn ${state.phases.iam_policy?.arn || '<arn>'}`)}`
  );
  console.log(`  - Unset secrets:  ${c.dim(`gh secret delete <NAME> --repo ${REPO}`)}`);
  console.log('');
}

// ---- status mode ---------------------------------------------------------

function statusOnly() {
  if (!existsSync(STATE_FILE)) {
    console.log(`No state file at ${STATE_FILE}. Nothing has been provisioned yet.`);
    exit(0);
  }
  const state = loadState();
  console.log(`State file: ${STATE_FILE}`);
  console.log(`Started:    ${state.started_at}`);
  if (state.phases.preflight) {
    const profile = state.phases.preflight.aws_profile;
    console.log(`AWS:        ${state.phases.preflight.aws_arn}`);
    console.log(`Profile:    ${profile === null ? '(default credentials)' : profile}`);
  }
  console.log('');
  for (const [name, phase] of Object.entries(state.phases)) {
    const at =
      phase.completed_at ||
      phase.recorded_at ||
      phase.attached_at ||
      phase.discovered_at ||
      phase.decided_at ||
      phase.created_at;
    console.log(`  ${c.green('✓')} ${name}${at ? ` (${at})` : ''}`);
  }
  console.log('');
  if (state.phases.sg_create) {
    console.log(c.bold('Manual teardown commands:'));
    if (state.phases.sg_create.sg_id)
      console.log(`  aws ec2 delete-security-group --group-id ${state.phases.sg_create.sg_id}`);
    if (state.phases.iam_attach && state.phases.iam_policy)
      console.log(
        `  aws iam detach-user-policy --user-name ${state.phases.iam_attach.username} --policy-arn ${state.phases.iam_policy.arn}`
      );
    if (state.phases.iam_policy) console.log(`  aws iam delete-policy --policy-arn ${state.phases.iam_policy.arn}`);
  }
  exit(0);
}

// ---- main ----------------------------------------------------------------

async function main() {
  if (FLAG.status) return statusOnly();

  if (FLAG.reset) {
    if (existsSync(STATE_FILE)) {
      const confirm = await askYesNo(
        c.yellow(`Wipe ${STATE_FILE}? This does NOT undo AWS changes — only forgets what's been done.`),
        { defaultYes: false }
      );
      if (!confirm) {
        console.log(`Aborted.`);
        exit(0);
      }
      resetState();
      ok(`State file removed.`);
    } else {
      info(`No state file to reset.`);
    }
  }

  // Save state on Ctrl+C so resume works cleanly.
  let state = loadState();
  rehydrateAwsProfile(state);
  const sigintHandler = () => {
    process.stdout.write('\n');
    warn(`Interrupted. State saved to ${STATE_FILE}; rerun the script to resume.`);
    saveState(state);
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  try {
    await preflight(state);
    const userChoice = await iamDecision(state);
    const shards = await prefixListsCreate(state);
    const policyArn = await iamPolicy(state);
    const username = await iamUser(state, userChoice);
    await iamAttach(state, username, policyArn);
    await sgFindVpc(state);
    const sgId = await sgCreate(state, state.phases.sg_vpc.vpc_id);
    await prefixListBootstrap(state);
    await sgIngress(state, sgId, shards);
    await repoSecrets(state);
    await verifySummary(state);
  } catch (e) {
    fail(`Aborted: ${e.message}`);
    if (e.stderr) console.error(c.dim(e.stderr.split('\n').slice(0, 8).join('\n')));
    fail(`State preserved in ${STATE_FILE}. Re-run to resume from the failed phase.`);
    exit(1);
  } finally {
    rl.close();
    process.removeListener('SIGINT', sigintHandler);
  }
}

await main();
