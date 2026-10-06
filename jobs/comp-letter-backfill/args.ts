/** Command-line parsing for the comp-letter backfill, split from `job.ts` so it can be tested without running a job. */

export const USAGE = 'usage: job.ts [--dump <wxycmusic-backup.sql.gz>] [--apply]';

export interface Args {
  apply: boolean;
  /** Path to the frozen tubafrenzy dump for the advisory cross-check; undefined skips it. */
  dump?: string;
}

/**
 * Strict on purpose. A misspelt or `--dump=<path>` argument must stop the run, not be ignored: ignoring it would let
 * `--apply` write without the cross-check the operator believed they asked for.
 *
 * @throws on an unknown argument or a `--dump` with no path after it
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--dump') {
      const path = argv[i + 1];
      if (path === undefined || path.startsWith('-')) throw new Error(`--dump needs a path. ${USAGE}`);
      args.dump = path;
      i += 1;
    } else {
      throw new Error(`unknown argument '${arg}'. ${USAGE}`);
    }
  }
  return args;
}
