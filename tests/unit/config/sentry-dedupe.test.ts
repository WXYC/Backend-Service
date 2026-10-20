/**
 * No `Sentry.init` installs the `Dedupe` integration (BS#3005).
 *
 * Sentry 11 turns `Dedupe` on by default. It drops an event that matches the
 * previous one, and with `attachStacktrace: false` (BS#3002) every
 * `captureMessage` of the same text matches, whatever its tags or extras.
 * An `integrations` array can only add to the defaults, so removal needs the
 * function form. The scan pins every site, the way
 * `sentry-attach-stacktrace.test.ts` pins `attachStacktrace`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as Sentry from '@sentry/node';

const repoRoot = path.resolve(__dirname, '../../..');
const sourceRoots = ['apps', 'jobs', 'shared'];

function walk(dir: string, out: string[]): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The argument text of each `Sentry.init(...)` call in `source`, by bracket matching. */
function initArguments(source: string): string[] {
  const args: string[] = [];
  const pattern = /Sentry\.init\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') {
        depth += 1;
      } else if (source[i] === ')') {
        depth -= 1;
      }
      i += 1;
    }
    args.push(source.slice(start, i - 1));
  }
  return args;
}

describe('Sentry.init call sites', () => {
  const sites: Array<{ file: string; args: string }> = [];
  for (const root of sourceRoots) {
    const dir = path.join(repoRoot, root);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const file of walk(dir, [])) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const args of initArguments(fs.readFileSync(file, 'utf-8'))) {
        sites.push({ file: path.relative(repoRoot, file), args });
      }
    }
  }

  it('finds the three app preloads and the job loggers', () => {
    const files = sites.map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/backend/instrument.ts',
        'apps/auth/instrument.ts',
        'apps/enrichment-worker/instrument.ts',
      ])
    );
    // Jobs migrated to createJobLogger (@wxyc/observability) no longer call Sentry.init
    // themselves, so this floor drops as each migration batch lands (BS#3399).
    expect(files.filter((f) => f.startsWith('jobs/')).length).toBeGreaterThanOrEqual(1);
  });

  it('filters Dedupe out of the default integrations at every site', () => {
    const missing = sites
      .filter((s) => !/integrations:\s*\(defaults\)\s*=>[\s\S]*?name\s*!==\s*'Dedupe'/.test(s.args))
      .map((s) => s.file);
    expect(missing).toEqual([]);
  });
});

describe('integrations option shape', () => {
  it('sends two identical captureMessage events with different tags and extras', async () => {
    const sent: unknown[] = [];
    const client = new Sentry.NodeClient({
      dsn: 'https://public@example.ingest.sentry.io/1',
      attachStacktrace: false,
      stackParser: Sentry.defaultStackParser,
      integrations: Sentry.getDefaultIntegrations({}).filter((i) => i.name !== 'Dedupe'),
      transport: () => ({
        send: (envelope) => {
          sent.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
    const scope = new Sentry.Scope();
    scope.setClient(client);
    client.init();

    scope.captureMessage('enrichment-empty-outcome', 'warning', { captureContext: { tags: { cause: 'a' } } });
    scope.captureMessage('enrichment-empty-outcome', 'warning', { captureContext: { tags: { cause: 'b' } } });
    await client.flush(1000);

    expect(sent).toHaveLength(2);
  });
});
