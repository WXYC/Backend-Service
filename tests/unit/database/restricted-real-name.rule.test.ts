/**
 * Tests for the wxyc/restricted-real-name ESLint rule.
 *
 * The rule flags a `realName`/`real_name` member-expression access (e.g.
 * `dj.realName`) or object-literal property key (e.g. `{ realName: ... }`)
 * outside a small allow-list of files that legitimately handle the
 * legal-name PII column — see docs/pii.md and eslint-rules/restricted-
 * real-name.cjs for the full rationale, the incident history
 * (BS#1286/#1288, `2a37bbc6`, BS#1393, BS#2281), and why the rule
 * deliberately carries no `user.name` clause.
 *
 * The allow-list lives inside the rule module itself (not as a config
 * option), so these tests exercise it directly via RuleTester's `filename`
 * on each case — proving "allow-listed file is valid" as real rule
 * behavior, not an artifact of eslint.config.mjs's `files` scoping (which
 * RuleTester bypasses entirely).
 */
import { RuleTester } from 'eslint';

// The rule plugin lives at `eslint-rules/restricted-real-name.cjs`. The
// CommonJS extension is deliberate so the same module loads from
// `eslint.config.mjs` (via ESM default-import interop) and from these
// ts-jest-compiled tests (which run under CommonJS) — same reasoning as
// the other *.rule.test.ts files in this directory.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wxycLocalRules = require('../../../eslint-rules/restricted-real-name.cjs') as {
  rules: { 'restricted-real-name': unknown };
};

const rule = wxycLocalRules.rules['restricted-real-name'];

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

// A file with no relationship to the DJ-name PII surface — used for both
// "unrelated identifiers are fine everywhere" and "a restricted read here
// is flagged" cases.
const NON_ALLOW_LISTED_FILE = 'apps/backend/services/some-random.service.ts';

ruleTester.run('restricted-real-name', rule, {
  valid: [
    // Allow-listed file: member access to realName is fine.
    {
      code: `const displayName = newAccount.realName || newAccount.username;`,
      filename: 'apps/auth/provision-user.ts',
    },
    // Allow-listed file: object-literal property key is fine.
    {
      code: `const payload = { realName: input.realName, dj_name: input.djName };`,
      filename: 'apps/auth/app.ts',
    },
    // Allow-listed file: snake_case member access is fine.
    {
      code: `const legal = row.real_name;`,
      filename: 'apps/auth/create-default-user.ts',
    },
    // Allow-listed file: the future hook-helper module (doesn't exist on
    // disk yet — allow-listing a nonexistent path is fine).
    {
      code: `export const deriveUserDisplayName = (data) => ({ data: { name: data.realName } });`,
      filename: 'shared/authentication/src/derive-user-display-name.ts',
    },
    // Allow-listed file: the legacy mirror's tubafrenzy DJ_NAME forward.
    {
      code: `const djName = dj.realName || dj.name;`,
      filename: 'shared/legacy-mirror/src/http-mirror.ts',
    },
    // Allow-listed file: the schema column definition itself.
    {
      code: `export const user = pgTable('auth_user', { realName: varchar('real_name', { length: 255 }) });`,
      filename: 'shared/database/src/schema.ts',
    },
    // Allow-listed path PREFIX: any file under the future one-shot
    // backfill job workspace.
    {
      code: `const target = resolveDjDisplayName(row.dj_name) ?? row.username;`,
      filename: 'jobs/auth-user-name-backfill/job.ts',
    },
    {
      code: `console.log(row.realName);`,
      filename: 'jobs/auth-user-name-backfill/writer.ts',
    },
    // Non-allow-listed file, but no restricted identifier anywhere —
    // unrelated `.name` / `.djName` reads must never fire (no `user.name`
    // clause, by design — see the rule's docblock).
    {
      code: `const handle = dj.name ?? dj.djName ?? user.username;`,
      filename: NON_ALLOW_LISTED_FILE,
    },
    // Non-allow-listed file: an object literal with unrelated keys.
    {
      code: `const payload = { name: dj.name, djName: dj.djName, id: dj.id };`,
      filename: NON_ALLOW_LISTED_FILE,
    },
    // Non-allow-listed file: a computed member access keyed by a variable
    // (not statically resolvable) is not flagged, by construction.
    {
      code: `const key = 'realName'; const value = row[key];`,
      filename: NON_ALLOW_LISTED_FILE,
    },
    // Non-allow-listed file: destructuring is a documented gap (Property
    // nodes inside an ObjectPattern, not an ObjectExpression) — proves the
    // rule doesn't over-fire on the pattern form it doesn't claim to cover.
    {
      code: `const { realName } = user;`,
      filename: NON_ALLOW_LISTED_FILE,
    },
  ],

  invalid: [
    // Non-allow-listed file: member-expression access, camelCase.
    {
      code: `const leaked = dj.realName;`,
      filename: NON_ALLOW_LISTED_FILE,
      errors: [{ messageId: 'restrictedRealName', data: { name: 'realName' } }],
    },
    // Non-allow-listed file: member-expression access, snake_case (the
    // raw DB column name, e.g. a raw SQL result row).
    {
      code: `const leaked = row.real_name;`,
      filename: NON_ALLOW_LISTED_FILE,
      errors: [{ messageId: 'restrictedRealName', data: { name: 'real_name' } }],
    },
    // Non-allow-listed file: computed member access with a string literal
    // key resolves the same as the dot form.
    {
      code: `const leaked = row['realName'];`,
      filename: NON_ALLOW_LISTED_FILE,
      errors: [{ messageId: 'restrictedRealName', data: { name: 'realName' } }],
    },
    // Non-allow-listed file: object-literal property key, camelCase — the
    // BS#1286 shape (`name: newAccount.realName || newAccount.username`
    // is ALSO invalid twice over: the key `name` is unrelated, but the
    // value expression's `.realName` access is itself flagged).
    {
      code: `const payload = { name: newAccount.realName || newAccount.username };`,
      filename: NON_ALLOW_LISTED_FILE,
      errors: [{ messageId: 'restrictedRealName', data: { name: 'realName' } }],
    },
    // Non-allow-listed file: object-literal property key, snake_case
    // (string-literal key form).
    {
      code: `const row = { 'real_name': legalName };`,
      filename: NON_ALLOW_LISTED_FILE,
      errors: [{ messageId: 'restrictedRealName', data: { name: 'real_name' } }],
    },
    // Non-allow-listed file: both shapes in one snippet — one error each.
    {
      code: `const leaked = dj.realName; const payload = { realName: leaked };`,
      filename: NON_ALLOW_LISTED_FILE,
      errors: [
        { messageId: 'restrictedRealName', data: { name: 'realName' } },
        { messageId: 'restrictedRealName', data: { name: 'realName' } },
      ],
    },
    // A file merely inside the same directory as an allow-listed prefix's
    // sibling must not match — "jobs/auth-user-name-backfill-other/..."
    // must not prefix-match "jobs/auth-user-name-backfill/".
    {
      code: `const leaked = row.realName;`,
      filename: 'jobs/auth-user-name-backfill-other/job.ts',
      errors: [{ messageId: 'restrictedRealName', data: { name: 'realName' } }],
    },
  ],
});
