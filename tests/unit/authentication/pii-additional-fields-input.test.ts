import * as fs from 'fs';
import * as path from 'path';

// FINDING 3 (BS#2297 review): auth.definition.ts's user.additionalFields
// defaulted realName/djName to input:true, so better-auth's public
// POST /update-user let any signed-in session rewrite them directly,
// bypassing every enumerated write flow (provisioning, onboarding,
// dj-site's admin.updateUser roster path). input:false closes that public
// write path.
//
// Verified before this change (against node_modules/better-auth v1.6.26 in
// this worktree) that input:false does NOT break the two legitimate writers:
//   - dj-site's roster editing calls authClient.admin.updateUser, whose
//     server route (plugins/admin/routes.mjs adminUpdateUser) passes
//     ctx.body.data straight to internalAdapter.updateUser(...) with no
//     parseUserInput/parseAdditionalUserInput call anywhere in that route —
//     the input:false filter is applied only by the public routes
//     (api/routes/update-user.mjs, api/routes/sign-up.mjs), never by the
//     admin plugin.
//   - provisioning (apps/auth/provision-user.ts, via
//     internalAdapter.createUser) and onboarding
//     (apps/auth/complete-onboarding.ts, via internalAdapter.updateUser)
//     both call internalAdapter methods directly; internalAdapter.createUser/
//     updateUser hand their payload straight to createWithHooks/
//     updateWithHooks (db/internal-adapter.mjs) with no parseUserInput call
//     either — input filtering lives only in the public route handlers.
describe('auth.definition.ts user.additionalFields PII input locks', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it('locks realName to input: false so the public /update-user route cannot write it directly', () => {
    const match = source.match(/realName:\s*\{([^}]*)\}/);
    if (match === null) {
      throw new Error('additionalFields.realName block not found in auth.definition.ts');
    }
    expect(match[1]).toMatch(/input:\s*false/);
  });

  it('locks djName to input: false so the public /update-user route cannot write it directly', () => {
    const match = source.match(/djName:\s*\{([^}]*)\}/);
    if (match === null) {
      throw new Error('additionalFields.djName block not found in auth.definition.ts');
    }
    expect(match[1]).toMatch(/input:\s*false/);
  });
});
