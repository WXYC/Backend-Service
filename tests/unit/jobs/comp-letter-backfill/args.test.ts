/**
 * The comp-letter backfill's argument parsing (BS#2834). Strict because a silently ignored `--dump` lets `--apply`
 * write without the cross-check the operator asked for.
 */

import { parseArgs } from '../../../../jobs/comp-letter-backfill/args';

describe('parseArgs', () => {
  it.each<[string[], { apply: boolean; dump?: string }]>([
    [[], { apply: false }],
    [['--apply'], { apply: true }],
    [['--dump', '/tmp/x.sql.gz'], { apply: false, dump: '/tmp/x.sql.gz' }],
    [['--apply', '--dump', '/tmp/x.sql.gz'], { apply: true, dump: '/tmp/x.sql.gz' }],
  ])('accepts %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each<[string[], RegExp]>([
    [['--dump'], /--dump needs a path/],
    [['--dump', '--apply'], /--dump needs a path/],
    [['--dump=/tmp/x.sql.gz', '--apply'], /unknown argument '--dump=\/tmp\/x.sql.gz'/],
    [['--aply'], /unknown argument '--aply'/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
