import * as fs from 'fs';
import * as path from 'path';

// FINDING 3 (BS#2297 review): auth.definition.ts's user.additionalFields
// defaulted realName/djName to input:true, so better-auth's public
// POST /update-user let any signed-in session rewrite them directly. Full
// writeup — the two-writers verification, and why this lock is complementary
// to (not redundant with) the databaseHooks.user veto — lives once, at the
// additionalFields.realName/djName site in auth.definition.ts.
describe('auth.definition.ts user.additionalFields PII input locks', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it.each(['realName', 'djName'])(
    'locks %s to input: false so the public /update-user route cannot write it directly',
    (field) => {
      const match = source.match(new RegExp(`${field}:\\s*\\{([^}]*)\\}`));
      if (match === null) {
        throw new Error(`additionalFields.${field} block not found in auth.definition.ts`);
      }
      expect(match[1]).toMatch(/input:\s*false/);
    }
  );
});
