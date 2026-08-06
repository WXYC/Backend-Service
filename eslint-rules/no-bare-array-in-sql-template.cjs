/**
 * @fileoverview Flags a bare JS array interpolated into a **Drizzle** `sql`
 * tagged template (BS#2010).
 *
 * ## The trap
 *
 * Interpolating a bare JS array into a Drizzle `sql` template does not bind
 * a PG array — Drizzle splats the array across N positional placeholders,
 * turning `= ANY(${ids})` into `= ANY(($1, $2, … $N))`, a row constructor.
 * Postgres rejects that at parse time (SQLSTATE 42809, "op ANY/ALL (array)
 * requires array on right side"). This has shipped to production three
 * times under three different call sites (BS#1068, BS#1071, #2007) because
 * each fix added another private copy of the work-around instead of a
 * shared helper PLUS something that stops the defective form from being
 * writable in the first place. This rule is the "something."
 *
 * The fix is `intArrayLiteral(...)` from `@wxyc/database` (BS#2010): it
 * builds a single PG-array-literal string (`'{1,2,3}'`), which the SQL text
 * casts explicitly (`::int[]`). For a text array there is no equivalent
 * shared helper (a hand-rolled literal needs real PG string escaping that
 * `intArrayLiteral` deliberately does not attempt — see its docblock); use
 * `jobs/album-reviews-etl/link.ts`'s `textArrayLiteral`, which does that
 * escaping, or join bound per-element parameters with `sql.join(...)` (see
 * `jobs/library-etl/job.ts`'s `buildLegacySourcedSetWhere` for a live
 * example of the API in this codebase) — never a naive unescaped
 * `.join(',')`.
 *
 * ## Why this must key on the Drizzle import specifically
 *
 * The IDENTICAL syntax is CORRECT under a raw postgres-js tagged template —
 * `sql\`… = ANY(${ids})\`` binds a genuine PG array there (e.g.
 * `getTestDb()` in this repo's integration tests). Both clients are used in
 * this codebase, so the same source line is right in one file and wrong in
 * another with no visible difference in the text. Getting this rule's
 * origin check backwards — flagging postgres-js call sites, or worse,
 * failing to flag Drizzle ones — would be worse than not shipping it at
 * all, per the issue that authored this rule. The check below resolves the
 * tag identifier's binding through scope analysis and only fires when it
 * traces back to a NAMED import of `sql` from `'drizzle-orm'` — a local
 * variable assigned from `postgres(...)` (or any other non-import origin)
 * is never flagged, by construction, because it never resolves to that
 * import binding.
 *
 * ## Detection strategy: type-aware, not positional
 *
 * The rule flags ANY interpolation in a confirmed Drizzle `sql` template
 * whose statically-known type is an array (or a union of array types) — not
 * just the ones textually inside `ANY(...)`. That is broader than "always
 * broken": Drizzle's positional splat is exactly what makes a splat-reliant
 * `` sql`… WHERE x IN ${ids}` `` legitimately work (it renders `IN ($1, $2,
 * $3)`, valid SQL, no cast needed) — `ANY(${ids})` is the one shape that
 * breaks (`ANY(($1, $2, $3))`, a row constructor `ANY` rejects). This rule
 * does not try to tell the two shapes apart; it enforces one POLICY
 * instead — every array bound into a Drizzle `sql` template goes through an
 * explicit literal-plus-cast helper and the `= ANY(...)` predicate form,
 * `IN`-lists included, rather than assert (falsely) that the splat is
 * always broken. That costs nothing to enforce today — there are zero live
 * `IN ${array}`-shaped call sites in this codebase (verified by grep before
 * shipping this rule) — but if a legitimate one shows up, the fix is the
 * same one this rule already points every author to: rewrite it to
 * `= ANY(${idArrayLiteral}::int[])`.
 *
 * A pure "is this `${}` textually right after `ANY(`" check (no type
 * information) was considered and rejected: it cannot tell the BROKEN shape
 * (`ANY(${ids})`, `ids: number[]`) from the FIXED one
 * (`ANY(${idArrayLiteral}::int[])`, `idArrayLiteral: string`) — both are
 * syntactically "`${Identifier}` immediately after `ANY(`". Shipping that
 * check would flag every one of the six call sites this rule's originating
 * issue (BS#2010) just fixed, which is worse than not shipping it (a rule
 * an author has to suppress at every already-correct call site trains
 * exactly the reflexive-disable habit that lets the next bad copy through).
 * The type check has no such blind spot and needs no positional fallback,
 * because full project type information is already a hard requirement of
 * this ESLint config (`tseslint.configs.recommendedTypeChecked` +
 * `parserOptions.projectService: true` in `eslint.config.mjs`) — it is not
 * an optional enhancement here to degrade gracefully away from.
 *
 * If parser services genuinely can't produce a type for a given expression
 * (a file outside the TS project, or some other resolution failure), this
 * rule silently doesn't fire for that expression rather than guessing —
 * failing open is the correct default for a rule whose false-positive cost
 * (training authors to reflexively suppress) is worse than an occasional
 * false negative.
 *
 * ## Known gaps (documented, not closed)
 *
 * Four ways a Drizzle `sql` tag can escape `isDrizzleSqlTag`'s scope-analysis
 * check, none exercised by any call site in this codebase today (verified by
 * grep before shipping this rule) — silent misses, listed here so a future
 * author who introduces one of these shapes knows the rule won't catch it:
 *
 *   1. **Re-exported through an intermediate module** — `export { sql } from
 *      'drizzle-orm'` in a barrel, then `import { sql } from
 *      '@some/other/module'` elsewhere. `isDrizzleSqlTag` resolves one
 *      import hop; it doesn't trace a re-export chain back through a second
 *      module to find the original `drizzle-orm` source.
 *   2. **Passed as a function parameter** — `` const build = (tag: typeof
 *      sql, ids: number[]) => tag`… ANY(${ids})` ``. The parameter's
 *      binding is a `Parameter` definition, not an `ImportBinding`, so the
 *      check never resolves it back to the `drizzle-orm` import.
 *   3. **A subpath import** — `import { sql } from 'drizzle-orm/pg-core'`
 *      (hypothetical; `sql` is exported from the package root today, not a
 *      subpath). `DRIZZLE_MODULE_SPECIFIER` is an exact string compare
 *      against `'drizzle-orm'`, not a prefix match.
 *   4. **A namespace import used as a member-expression tag** — `import *
 *      as drizzle from 'drizzle-orm'; drizzle.sql\`… ANY(${ids})\``.
 *      `isDrizzleSqlTag` only handles a bare `Identifier` tag; `drizzle.sql`
 *      is a `MemberExpression` and is rejected before scope resolution even
 *      runs.
 */

'use strict';

const { ASTUtils, ESLintUtils } = require('@typescript-eslint/utils');

const DRIZZLE_MODULE_SPECIFIER = 'drizzle-orm';
const DRIZZLE_SQL_IMPORTED_NAME = 'sql';

const MESSAGE =
  "Bare array interpolated into a Drizzle `sql` template. Drizzle splats a JS array across N positional placeholders here. Inside `ANY(...)` that breaks the query — `ANY(${arr})` becomes `ANY(($1, $2, … $N))`, a row constructor Postgres rejects at parse time (42809, \"op ANY/ALL (array) requires array on right side\"; the BS#1068/BS#1071/#2007 family); inside `IN ...` the splat happens to still produce valid SQL, but this rule enforces one predicate shape everywhere regardless. Fix: build a PG array-literal string first and interpolate THAT, using `= ANY(...)` (rewrite a working `IN ${arr}` the same way). For an integer array, use `intArrayLiteral(...)` from `@wxyc/database` and cast in SQL (`= ANY(${arr}::int[])`); for a text array, use `jobs/album-reviews-etl/link.ts`'s `textArrayLiteral` (real PG quoting) or join bound per-element parameters with `sql.join(...)` (see `jobs/library-etl/job.ts`'s `buildLegacySourcedSetWhere` for the API) — never a naive unescaped `.join(',')`. This exact syntax IS correct under a raw postgres-js tagged template (e.g. `getTestDb()` in this repo's integration tests) — only Drizzle's `sql` import is affected; do not \"fix\" a postgres-js call site with this.";

/**
 * True if `tagNode` (a `TaggedTemplateExpression`'s `.tag`) is a bare
 * Identifier whose binding resolves — via scope analysis, not string
 * matching — to a named `sql` import from `'drizzle-orm'`.
 */
function isDrizzleSqlTag(tagNode, context) {
  if (tagNode.type !== 'Identifier') return false;

  const sourceCode = context.sourceCode || context.getSourceCode();
  const scope = sourceCode.getScope ? sourceCode.getScope(tagNode) : context.getScope();
  const variable = ASTUtils.findVariable(scope, tagNode.name);
  if (!variable) return false;

  return variable.defs.some((def) => {
    if (def.type !== 'ImportBinding') return false;
    const specifier = def.node; // ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier
    const importDecl = def.parent; // ImportDeclaration
    if (!importDecl || importDecl.type !== 'ImportDeclaration') return false;
    if (importDecl.source.value !== DRIZZLE_MODULE_SPECIFIER) return false;
    if (specifier.type !== 'ImportSpecifier') return false; // excludes `import * as X` / default import
    const imported = specifier.imported;
    const importedName = imported.type === 'Identifier' ? imported.name : imported.value;
    return importedName === DRIZZLE_SQL_IMPORTED_NAME;
  });
}

/**
 * Is `exprNode`'s statically-known type an array type (or union of array
 * types)? Returns false — never throws — if full type information isn't
 * available, so this degrades to a no-op rather than a crash when a file
 * falls outside the TS project (see the module docblock for why that's the
 * right failure mode for this specific rule).
 */
function makeIsArrayTypedExpression(context) {
  let services;
  try {
    services = ESLintUtils.getParserServices(context, true);
  } catch {
    return () => false;
  }
  if (!services || !services.program || !services.esTreeNodeToTSNodeMap) {
    return () => false;
  }

  // Deferred require: @typescript-eslint/type-utils pulls in the TS
  // compiler; only pay for it in files where parser services actually
  // resolved (guards the common early-return above for free).
  let isTypeArrayTypeOrUnionOfArrayTypes;
  try {
    ({ isTypeArrayTypeOrUnionOfArrayTypes } = require('@typescript-eslint/type-utils'));
  } catch {
    return () => false;
  }

  const checker = services.program.getTypeChecker();

  return (exprNode) => {
    try {
      const tsNode = services.esTreeNodeToTSNodeMap.get(exprNode);
      if (!tsNode) return false;
      const type = checker.getTypeAtLocation(tsNode);
      return isTypeArrayTypeOrUnionOfArrayTypes(type, checker);
    } catch {
      // A single expression's type failing to resolve must not take down
      // the whole lint run — fail open (don't flag) for that expression.
      return false;
    }
  };
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a bare array interpolated into a Drizzle `sql` tagged template — it splats into a row constructor instead of binding a PG array (BS#1068/BS#1071/#2007). Does not fire on postgres-js tagged templates.',
    },
    schema: [],
    messages: {
      bareArrayInSqlTemplate: MESSAGE,
    },
  },

  create(context) {
    const isArrayTypedExpression = makeIsArrayTypedExpression(context);

    return {
      TaggedTemplateExpression(node) {
        if (!isDrizzleSqlTag(node.tag, context)) return;

        for (const exprNode of node.quasi.expressions) {
          if (isArrayTypedExpression(exprNode)) {
            context.report({ node: exprNode, messageId: 'bareArrayInSqlTemplate' });
          }
        }
      },
    };
  },
};

module.exports = {
  rules: {
    'no-bare-array-in-sql-template': rule,
  },
};
