import * as fs from 'fs';
import * as path from 'path';

// Without an explicit session config, better-auth defaults to
// expiresIn = 7 days, updateAge = 1 day. Combined with the bearer plugin's
// per-renewal token rotation, this surfaced as DJs being silently signed out
// after roughly a day (the iOS app didn't capture the rotated set-auth-token,
// so the first 24h-renewal call invalidated their bearer). The iOS app now
// captures the header, but the backend should also pin these values
// explicitly so the implicit defaults don't silently shorten sessions again.

// Evaluate a multiplication-only integer expression like "60 * 60 * 24 * 365".
// Avoids the Function constructor (banned by no-implied-eval).
function evalMultiplication(expression: string): number {
  return expression
    .split('*')
    .map((factor) => factor.replace(/_/g, '').trim())
    .reduce((product, factor) => {
      const value = Number(factor);
      if (!Number.isFinite(value)) {
        throw new Error(`Unparseable factor '${factor}' in '${expression}'`);
      }
      return product * value;
    }, 1);
}

describe('auth.definition.ts session configuration', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it('defines a top-level session block (distinct from the schema mapping)', () => {
    expect(source).toMatch(/session:\s*\{[\s\S]*?expiresIn/);
  });

  it('sets expiresIn to at least 30 days', () => {
    const match = source.match(/session:\s*\{[\s\S]*?expiresIn:\s*([0-9*\s_]+?)[,\n}]/);
    if (match === null) {
      throw new Error('session.expiresIn not found in auth.definition.ts');
    }
    const seconds = evalMultiplication(match[1]);
    const minimumSeconds = 30 * 24 * 60 * 60;
    expect(seconds).toBeGreaterThanOrEqual(minimumSeconds);
  });

  it('sets updateAge to no more than 1 day so renewal happens daily on use', () => {
    const match = source.match(/session:\s*\{[\s\S]*?updateAge:\s*([0-9*\s_]+?)[,\n}]/);
    if (match === null) {
      throw new Error('session.updateAge not found in auth.definition.ts');
    }
    const seconds = evalMultiplication(match[1]);
    const oneDaySeconds = 24 * 60 * 60;
    expect(seconds).toBeLessThanOrEqual(oneDaySeconds);
  });
});
