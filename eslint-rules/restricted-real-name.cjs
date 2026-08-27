/**
 * @fileoverview Flags a `realName` / `real_name` read or write outside an
 * allow-listed file (docs/pii.md; the "DJ real-name PII safeguards" plan).
 *
 * ## The incident this closes
 *
 * `auth_user.real_name` is the sole legal-name (PII) carrier in this
 * schema. Commit `a0cd1979` (2025-12-31) conflated it with the public
 * on-air handle by introducing `djName || name` fallback chains and a
 * dj-site provisioning flow that filled better-auth's required `name`
 * field with `realName || username` — from then on `auth_user.name` was a
 * hidden second copy of the legal name, and BS#1286/#1288, `2a37bbc6`,
 * BS#1393, and BS#2281 are all downstream of that one structural fact. See
 * docs/pii.md for the full registry and history.
 *
 * This rule targets the narrower, still-open half of that risk: a NEW read
 * or write of `real_name` itself, anywhere outside the small set of files
 * that legitimately handle it (provisioning, the auth definition, the
 * legacy mirror's tubafrenzy forward, the schema column definition, and
 * the pending name-backfill job). A new legitimate PII read requires an
 * allow-list edit in the same PR — reviewable, grep-able, and it converts
 * "someone remembered the doctrine" into "CI failed."
 *
 * ## Why both AST shapes
 *
 * `realName`/`real_name` reaches a read or write site two ways in this
 * codebase, and either shape alone misses roughly half of them:
 *
 *   - **Member-expression access**: `user.realName`, `dj.real_name`,
 *     `row['realName']`.
 *   - **Object-literal property keys**: `{ realName: value }`,
 *     `{ real_name: newAccount.realName }` — construction sites (building
 *     a payload to send somewhere) read just as much like a leak risk as
 *     an access site, and BS#1286's originating incident was exactly a
 *     construction site (`RosterTable.tsx`'s `name: realName || username`).
 *
 * ## Why no `user.name` clause
 *
 * The incident shape is alias-bound — `dj.name` at the mirror call site,
 * not `user.name` or `auth_user.name` as a literal identifier — so an
 * identifier-keyed matcher on bare `name` would catch none of the
 * historical cases. It would also be unusably noisy: `name` is a column on
 * at least three tables in this schema (`auth_user.name`,
 * `specialty_shows.name`, etc.), so a bare `.name`/`{ name: ... }` matcher
 * would fire constantly on code with nothing to do with DJ identity. That
 * half of the risk is closed by keeping the legacy mirror off
 * `auth_user.name` entirely (see `shared/database/src/dj-name.ts`) and by
 * docs/pii.md's registry, not by lint. Claiming lint coverage this rule
 * cannot deliver would be exactly the false-assurance failure the
 * originating plan indicts elsewhere.
 *
 * ## Allow-list matching
 *
 * Entries are repo-root-relative paths, resolved against the linted file's
 * path relative to `context.cwd` (falling back to `process.cwd()` on older
 * ESLint). An entry ending in `/` is a path-prefix match (covers a whole
 * directory, including files that don't exist yet — e.g. the pending
 * `jobs/auth-user-name-backfill/` one-shot job); any other entry is an
 * exact match.
 *
 * ## Known gaps (documented, not closed)
 *
 * Two shapes this rule does not cover, both out of the plan's stated scope
 * for this rule (see docs/pii.md's Enforcement section):
 *
 *   1. **Destructuring** — `const { realName } = user;` is an
 *      `ObjectPattern`, not the `ObjectExpression` this rule inspects.
 *   2. **Type-only declarations** — `interface X { realName: string }` /
 *      `type X = { realName: string }` are `TSPropertySignature` nodes,
 *      not the runtime `Property` this rule inspects.
 *
 * Neither shape appears at a non-allow-listed call site in this codebase
 * today (verified by grep before shipping this rule).
 */

'use strict';

const path = require('path');

const RESTRICTED_NAMES = new Set(['realName', 'real_name']);

// Repo-root-relative. Trailing "/" = prefix match (directory); otherwise
// exact match. Keep in sync with docs/pii.md's Enforcement section, which
// documents WHY each entry is here.
const ALLOW_LIST = [
  'apps/auth/app.ts',
  'apps/auth/provision-user.ts',
  'apps/auth/create-default-user.ts',
  'apps/auth/complete-onboarding.ts',
  'apps/auth/create-auto-dj-user.ts',
  'shared/authentication/src/auth.definition.ts',
  // Future hook-helper file (Track 2b of the originating plan) — not yet
  // written. Allow-listing a nonexistent path is fine: the rule only ever
  // consults this list against files that DO get linted.
  'shared/authentication/src/derive-user-display-name.ts',
  // Until the 2026-08-31 tubafrenzy turndown: the legacy mirror forwards
  // `auth_user.real_name` into tubafrenzy's DJ_NAME field.
  'shared/legacy-mirror/src/http-mirror.ts',
  // The `real_name` column definition itself.
  'shared/database/src/schema.ts',
  // Future one-shot backfill job (Track 2d) — prefix, not yet written.
  'jobs/auth-user-name-backfill/',
];

const MESSAGE =
  "'{{name}}' read/written outside the PII allow-list (docs/pii.md). `auth_user.real_name` is the sole legal-name (PII) carrier in this schema — see docs/pii.md for the registry and BS#1286/#1288/#1393/#2281 for the incident history a stray real-name read produced. If this is a genuine new legal-name read/write site, add this file to the ALLOW_LIST in eslint-rules/restricted-real-name.cjs (and to docs/pii.md's Enforcement section) in the same PR; otherwise use the public on-air handle instead (`dj_name` / `resolveDjDisplayName`, see shared/database/src/dj-name.ts).";

/**
 * Repo-root-relative, forward-slash-normalized path for `filename`,
 * resolved against `cwd`. `filename` may already be relative (as RuleTester
 * test cases pass it) or absolute (as real ESLint runs pass it) — both
 * resolve to the same relative form via `path.relative(path.resolve(cwd,
 * filename), ...)`... more simply: resolve `filename` to an absolute path
 * first, then relativize against `cwd`.
 */
function toRepoRelativePath(filename, cwd) {
  const absolute = path.resolve(cwd, filename);
  return path.relative(cwd, absolute).split(path.sep).join('/');
}

function isAllowListed(relativePath) {
  return ALLOW_LIST.some((entry) => {
    if (entry.endsWith('/')) return relativePath.startsWith(entry);
    return relativePath === entry;
  });
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow a `realName`/`real_name` member access or object-literal property key outside the PII allow-list. `auth_user.real_name` is the schema's sole legal-name (PII) carrier (docs/pii.md).",
    },
    schema: [],
    messages: {
      restrictedRealName: MESSAGE,
    },
  },

  create(context) {
    const cwd = context.cwd || process.cwd();
    const filename = context.filename || context.getFilename();
    const relativePath = toRepoRelativePath(filename, cwd);

    if (isAllowListed(relativePath)) {
      return {};
    }

    return {
      // Member-expression access: `user.realName`, `dj.real_name`,
      // `row['realName']`. Covers both non-computed (Identifier property)
      // and computed-with-a-string-literal forms; a computed access keyed
      // by a variable (`row[key]`) is not statically resolvable and is not
      // flagged, by construction — same fail-open posture as this
      // codebase's other type-aware rules take when they can't determine
      // an answer.
      MemberExpression(node) {
        const prop = node.property;
        if (!node.computed && prop.type === 'Identifier' && RESTRICTED_NAMES.has(prop.name)) {
          context.report({ node: prop, messageId: 'restrictedRealName', data: { name: prop.name } });
          return;
        }
        if (
          node.computed &&
          prop.type === 'Literal' &&
          typeof prop.value === 'string' &&
          RESTRICTED_NAMES.has(prop.value)
        ) {
          context.report({ node: prop, messageId: 'restrictedRealName', data: { name: prop.value } });
        }
      },

      // Object-literal property keys: `{ realName: ... }`,
      // `{ 'real_name': ... }`. Skips ObjectPattern destructuring (`const {
      // realName } = user`) by construction — Property nodes appear in
      // both ObjectExpression and ObjectPattern, but only the former is a
      // construction site; see the module docblock's Known Gaps section.
      Property(node) {
        if (node.parent.type !== 'ObjectExpression') return;
        const key = node.key;
        if (!node.computed && key.type === 'Identifier' && RESTRICTED_NAMES.has(key.name)) {
          context.report({ node: key, messageId: 'restrictedRealName', data: { name: key.name } });
          return;
        }
        if (key.type === 'Literal' && typeof key.value === 'string' && RESTRICTED_NAMES.has(key.value)) {
          context.report({ node: key, messageId: 'restrictedRealName', data: { name: key.value } });
        }
      },
    };
  },
};

module.exports = {
  rules: {
    'restricted-real-name': rule,
  },
};
