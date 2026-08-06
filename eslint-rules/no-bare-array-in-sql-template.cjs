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
 * casts explicitly (`::int[]`). For a text array, the honest fix is a
 * `sql.join(...)`-built VALUES list (see `jobs/album-reviews-etl/link.ts`)
 * — a hand-rolled text array literal needs real PG string escaping that
 * `intArrayLiteral` deliberately does not attempt (see its docblock).
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
 * just the ones textually inside `ANY(...)`. A bare array is never valid
 * ANYWHERE in a Drizzle `sql` template (there is no drizzle-orm API that
 * treats a raw interpolated array as anything other than a positional
 * splat), so this check has no legitimate exception to carve out — unlike a
 * plain AST/position check, it needs none.
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
 */

'use strict';

const { ASTUtils, ESLintUtils } = require('@typescript-eslint/utils');

const DRIZZLE_MODULE_SPECIFIER = 'drizzle-orm';
const DRIZZLE_SQL_IMPORTED_NAME = 'sql';

const MESSAGE =
  'Bare array interpolated into a Drizzle `sql` template. Drizzle splats a JS array across N positional placeholders here — `ANY(${arr})` becomes `ANY(($1, $2, … $N))`, a row constructor — which Postgres rejects at parse time (42809, "op ANY/ALL (array) requires array on right side"; the BS#1068/BS#1071/#2007 family). Fix: build a PG array-literal string first and interpolate THAT instead. For an integer array, use `intArrayLiteral(...)` from `@wxyc/database` and cast in SQL (`::int[]`); for a text array, use a `sql.join(...)`-built VALUES list (see `jobs/album-reviews-etl/link.ts`), not a hand-rolled literal. This exact syntax IS correct under a raw postgres-js tagged template (e.g. `getTestDb()` in this repo\'s integration tests) — only Drizzle\'s `sql` import is affected; do not "fix" a postgres-js call site with this.';

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
