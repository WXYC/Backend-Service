import * as fs from 'fs';
import * as path from 'path';

describe('auth.definition.ts cookie configuration', () => {
  const authDefPath = path.resolve(
    __dirname,
    '../../../shared/authentication/src/auth.definition.ts'
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it('should not use sameSite: none (weakens CSRF protection)', () => {
    const hardcodedNone = /sameSite:\s*['"]none['"]/;
    expect(source).not.toMatch(hardcodedNone);

    expect(source).toMatch(/sameSite:/);
  });

  it('should set secure: true on cookies', () => {
    expect(source).toMatch(/secure:\s*true/);
  });
});
