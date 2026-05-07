#!/usr/bin/env node

/**
 * Sync the AWS managed prefix lists `wxyc-gha-egress-{1..N}` against
 * `https://api.github.com/meta` `.actions[]` IPv4 CIDRs.
 *
 * The migrate-dryrun workflow (test.yml) restores a prod RDS snapshot
 * to a publicly-accessible sandbox and connects from a GitHub-hosted
 * runner. Ingress is gated by the security group `wxyc-dryrun-gha`,
 * which references these prefix lists. GitHub publishes ~5000 IPv4
 * CIDRs for runner egress; aggregation collapses adjacent ranges to
 * ~3300 entries; AWS hard-caps a managed PL at 1000 entries (no quota
 * increase available). So we shard across N PLs (default 5) and
 * reference all of them from the SG.
 *
 * Sharding: each CIDR's bucket is determined by SHA-256 of its string
 * form, mod N. This is stable — adding a new CIDR upstream only
 * changes its assigned bucket's PL, not the others, so per-run diffs
 * stay small.
 *
 * Operations (per PL):
 *   1. Resolve PL ID by name via Describe.
 *   2. Fetch current entries via GetManagedPrefixListEntries.
 *   3. Compute set diff (add = desired − current, remove = current − desired).
 *   4. Apply via ModifyManagedPrefixList in batches of 100, threading
 *      the version cursor between calls.
 *
 * AWS imposes a max of 100 entries per modify call (combined add+remove).
 * Each call returns a new version; the next call must pass that version
 * as `--current-version` or AWS rejects with `IncorrectState`. We poll
 * for state=`modify-complete` between calls so the cursor is accurate.
 *
 * Usage:
 *   node scripts/sync-gha-prefix-list.mjs                   # apply
 *   node scripts/sync-gha-prefix-list.mjs --dry-run         # print diff, no changes
 *   node scripts/sync-gha-prefix-list.mjs --shards 8        # override N
 *   node scripts/sync-gha-prefix-list.mjs --name-prefix foo # override name pattern
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { exit } from 'process';

const args = process.argv.slice(2);
const FLAG = {
  dryRun: args.includes('--dry-run'),
};
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const NAME_PREFIX = argValue('--name-prefix', 'wxyc-gha-egress');
const SHARDS = parseInt(argValue('--shards', '5'), 10);

const META_URL = 'https://api.github.com/meta';
const BATCH_MAX = 100;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function run(cmd, { input = null } = {}) {
  const result = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', input: input ?? undefined });
  if (result.status !== 0) {
    const err = new Error(`${cmd[0]} ${cmd[1] || ''} exited ${result.status}: ${(result.stderr || '').trim()}`);
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    err.status = result.status;
    throw err;
  }
  return (result.stdout || '').trim();
}

const aws = (a) => run(['aws', ...a]);
const awsJson = (a) => JSON.parse(aws(a) || 'null');

function log(msg) {
  console.log(msg);
}

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

// ---- CIDR aggregation (IPv4 only) ----------------------------------------

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`bad IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) throw new Error(`bad IPv4 octet: ${ip}`);
    n = n * 256 + o;
  }
  return n;
}
function intToIp(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}
function cidrToRange(cidr) {
  const [ip, prefix] = cidr.split('/');
  const p = Number(prefix);
  if (!Number.isInteger(p) || p < 0 || p > 32) throw new Error(`bad CIDR: ${cidr}`);
  const base = ipToInt(ip);
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  const start = (base & mask) >>> 0;
  const size = p === 32 ? 1 : 2 ** (32 - p);
  const end = (start + size - 1) >>> 0;
  return [start, end];
}
function rangeToCidrs(start, end) {
  // Decompose [start, end] into the minimum set of aligned CIDR blocks.
  const out = [];
  let s = start;
  while (s <= end) {
    // Largest prefix length: max prefix where (s aligned to that prefix) AND (block fits in [s, end]).
    let prefix = 32;
    while (prefix > 0) {
      const blockSize = 2 ** (32 - (prefix - 1));
      const candidatePrefix = prefix - 1;
      const aligned = s % blockSize === 0;
      const fits = s + blockSize - 1 <= end;
      if (aligned && fits && blockSize <= end - s + 1) {
        prefix = candidatePrefix;
      } else {
        break;
      }
    }
    const blockSize = 2 ** (32 - prefix);
    out.push(`${intToIp(s)}/${prefix}`);
    s += blockSize;
    if (s > 0xffffffff) break;
  }
  return out;
}
function aggregateIpv4(cidrs) {
  const ranges = cidrs.map(cidrToRange).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length && s <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  const out = [];
  for (const [s, e] of merged) out.push(...rangeToCidrs(s, e));
  return out;
}

function bucketFor(cidr, n) {
  const h = createHash('sha256').update(cidr).digest();
  return h.readUInt32BE(0) % n;
}

// ---- AWS calls -----------------------------------------------------------

function fetchGithubActionsCidrs() {
  log(`→ Fetching ${META_URL}`);
  const meta = JSON.parse(run(['curl', '-sSf', META_URL]));
  const all = meta.actions || [];
  const ipv4 = all.filter((c) => !c.includes(':'));
  log(`  ${all.length} total actions ranges (${ipv4.length} IPv4, ${all.length - ipv4.length} IPv6)`);
  const aggregated = aggregateIpv4(ipv4);
  log(`  ${aggregated.length} aggregated IPv4 CIDR(s)`);
  return aggregated;
}

function resolvePrefixList(name) {
  const out = awsJson([
    'ec2',
    'describe-managed-prefix-lists',
    '--filters',
    `Name=prefix-list-name,Values=${name}`,
    '--output',
    'json',
  ]);
  const customer = (out.PrefixLists || []).filter((p) => p.OwnerId && p.OwnerId !== 'AWS');
  if (!customer.length) throw new Error(`Prefix list "${name}" not found. Run scripts/provision-dryrun-aws.mjs first.`);
  if (customer.length > 1)
    throw new Error(`Multiple PLs named "${name}": ${customer.map((p) => p.PrefixListId).join(', ')}`);
  return customer[0];
}

function getCurrentEntries(plId) {
  const out = awsJson(['ec2', 'get-managed-prefix-list-entries', '--prefix-list-id', plId, '--output', 'json']);
  return out.Entries || [];
}

function describePrefixList(plId) {
  const out = awsJson(['ec2', 'describe-managed-prefix-lists', '--prefix-list-ids', plId, '--output', 'json']);
  return out.PrefixLists[0];
}

function waitForStable(plId) {
  const start = Date.now();
  while (true) {
    const pl = describePrefixList(plId);
    if (pl.State === 'create-complete' || pl.State === 'modify-complete' || pl.State === 'restore-complete') {
      return pl;
    }
    if (pl.State.endsWith('-failed')) {
      throw new Error(`Prefix list ${plId} entered terminal state ${pl.State}: ${pl.StateMessage || ''}`);
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(`Prefix list ${plId} did not stabilize in ${POLL_TIMEOUT_MS}ms (last state: ${pl.State})`);
    }
    sleepSync(POLL_INTERVAL_MS);
  }
}

function buildEntriesArg(cidrs, description) {
  return cidrs.map((c) => `Cidr=${c}` + (description ? `,Description=${description}` : ''));
}

function applyBatch(plId, currentVersion, addBatch, removeBatch) {
  const cmd = [
    'ec2',
    'modify-managed-prefix-list',
    '--prefix-list-id',
    plId,
    '--current-version',
    String(currentVersion),
    '--output',
    'json',
  ];
  if (addBatch.length) {
    cmd.push('--add-entries', ...buildEntriesArg(addBatch, 'GitHub Actions egress (api.github.com/meta .actions)'));
  }
  if (removeBatch.length) {
    cmd.push('--remove-entries', ...buildEntriesArg(removeBatch, ''));
  }
  awsJson(cmd);
}

function syncOnePrefixList(name, desired) {
  log(`\n══ ${name} ══`);
  const pl = resolvePrefixList(name);
  log(`  ${pl.PrefixListId} (version ${pl.Version}, MaxEntries ${pl.MaxEntries}, state ${pl.State})`);

  const currentEntries = getCurrentEntries(pl.PrefixListId);
  const currentSet = new Set(currentEntries.map((e) => e.Cidr));
  const desiredSet = new Set(desired);
  const toAdd = [...desiredSet].filter((c) => !currentSet.has(c)).sort();
  const toRemove = [...currentSet].filter((c) => !desiredSet.has(c)).sort();

  log(`  current ${currentSet.size} / desired ${desiredSet.size}; +${toAdd.length} / -${toRemove.length}`);

  if (toAdd.length === 0 && toRemove.length === 0) {
    log('  no changes');
    return { added: 0, removed: 0 };
  }

  const projected = currentSet.size + toAdd.length - toRemove.length;
  if (projected > pl.MaxEntries) {
    throw new Error(
      `${name}: projected entries (${projected}) exceed PL MaxEntries (${pl.MaxEntries}). ` +
        `Increase shard count via --shards or grow the PL via modify-managed-prefix-list --max-entries.`
    );
  }

  if (FLAG.dryRun) {
    log(`  --dry-run: would apply +${toAdd.length} / -${toRemove.length}`);
    if (toAdd.length)
      log(`    add sample: ${toAdd.slice(0, 5).join(', ')}${toAdd.length > 5 ? `, ... (+${toAdd.length - 5})` : ''}`);
    if (toRemove.length)
      log(
        `    remove sample: ${toRemove.slice(0, 5).join(', ')}${toRemove.length > 5 ? `, ... (+${toRemove.length - 5})` : ''}`
      );
    return { added: toAdd.length, removed: toRemove.length, dryRun: true };
  }

  let live = waitForStable(pl.PrefixListId);
  let version = live.Version;
  let addQueue = [...toAdd];
  let removeQueue = [...toRemove];
  let batchNum = 0;
  while (addQueue.length || removeQueue.length) {
    const removeBatch = removeQueue.splice(0, Math.min(BATCH_MAX, removeQueue.length));
    const addBatch = addQueue.splice(0, Math.min(BATCH_MAX - removeBatch.length, addQueue.length));
    batchNum++;
    log(`  batch ${batchNum}: +${addBatch.length} / -${removeBatch.length} at version ${version}`);
    applyBatch(pl.PrefixListId, version, addBatch, removeBatch);
    live = waitForStable(pl.PrefixListId);
    version = live.Version;
  }
  log(`  ✓ done; PL at version ${version}`);
  return { added: toAdd.length, removed: toRemove.length };
}

async function main() {
  log(`sync-gha-prefix-list — ${FLAG.dryRun ? 'DRY RUN' : 'APPLY'} (shards=${SHARDS})`);

  const aggregated = fetchGithubActionsCidrs();
  if (aggregated.length === 0) {
    throw new Error('api.github.com/meta returned no IPv4 .actions ranges; refusing to wipe prefix lists.');
  }

  // Distribute across shards by stable hash. New entries land in the
  // same bucket on every run unless the upstream string form changes.
  const buckets = Array.from({ length: SHARDS }, () => []);
  for (const cidr of aggregated) buckets[bucketFor(cidr, SHARDS)].push(cidr);
  for (const b of buckets) b.sort();
  log(`  distribution: ${buckets.map((b) => b.length).join(', ')}`);

  let totalAdded = 0;
  let totalRemoved = 0;
  for (let i = 0; i < SHARDS; i++) {
    const name = `${NAME_PREFIX}-${i + 1}`;
    const r = syncOnePrefixList(name, buckets[i]);
    totalAdded += r.added;
    totalRemoved += r.removed;
  }
  log(`\n✓ overall: +${totalAdded} / -${totalRemoved} across ${SHARDS} shard(s)`);
}

main().catch((e) => {
  console.error(`sync-gha-prefix-list failed: ${e.message}`);
  if (e.stderr) console.error(e.stderr);
  exit(1);
});
