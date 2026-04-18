import * as fs from 'fs';
import * as path from 'path';

describe('auth.definition.ts cookie configuration', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it('should not use sameSite: none (weakens CSRF protection)', () => {
    const hardcodedNone = /sameSite:\s*['"]none['"]/;
    expect(source).not.toMatch(hardcodedNone);

    expect(source).toMatch(/sameSite:/);
  });

  it('should not hardcode secure: false on cookies', () => {
    // In production, cookies must be secure. The code uses
    // `secure: process.env.NODE_ENV === 'production'` which is correct —
    // hardcoding `true` would break local development over HTTP.
    expect(source).not.toMatch(/secure:\s*false/);
    expect(source).toMatch(/secure:/);
  });
});
