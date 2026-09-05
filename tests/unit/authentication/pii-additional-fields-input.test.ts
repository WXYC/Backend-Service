import * as fs from 'fs';
import * as path from 'path';

// FINDING 3 (BS#2297 review): auth.definition.ts's user.additionalFields
// defaulted realName/djName to input:true, so better-auth's public
// POST /update-user let any signed-in session rewrite them directly. Full
// writeup — the two-writers verification, and why this lock is complementary
// to (not redundant with) the databaseHooks.user veto — lives once, at the
// additionalFields.realName/djName site in auth.definition.ts.
//
// The station-signup-schema plan (BS#2358) extends the same lock to the three
// new review-tracking fields — self_signup_reviewed_at/_by are exactly the
// shape BS#2297 warned about, and the account holder under review is signed
// in — and retrofits it onto hasCompletedOnboarding, which was registered
// without the flag and so was already writable by any signed-in session via
// public /update-user.
describe('auth.definition.ts user.additionalFields PII input locks', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it.each([
    'realName',
    'djName',
    'selfSignupAt',
    'selfSignupReviewedAt',
    'selfSignupReviewedBy',
    'hasCompletedOnboarding',
  ])('locks %s to input: false so the public /update-user route cannot write it directly', (field) => {
    const match = source.match(new RegExp(`${field}:\\s*\\{([^}]*)\\}`));
    if (match === null) {
      throw new Error(`additionalFields.${field} block not found in auth.definition.ts`);
    }
    expect(match[1]).toMatch(/input:\s*false/);
  });
});
