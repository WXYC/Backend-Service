/**
 * @fileoverview Warns when a constraint (uniqueIndex, check, notNull, unique)
 * is added to a Drizzle table whose definition is preceded by a `SOURCE:`
 * comment.
 *
 * SOURCE-tagged tables are downstream of an upstream system (tubafrenzy, the
 * legacy MySQL library, LML's entity.identity, etc.). The upstream owns the
 * data shape; constraints added at the Drizzle layer can contradict shapes
 * the upstream permits and block the next ETL pass. See
 * WXYC/Backend-Service#702 and the 2026-04-30 rotation incident for context.
 *
 * The rule emits a warning, never an error. Suppress per occurrence with:
 *   // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
 * once the constraint has been confirmed consistent with the upstream's
 * data shape.
 *
 * Authored as CommonJS so the same module loads from both
 * `eslint.config.mjs` (via ESM default-import interop) and the Jest unit
 * tests (which run under ts-jest in CJS mode).
 */

'use strict';

const SOURCE_TAG_RE = /\bSOURCE:\s*/;
const CONSTRAINT_CALLEES = new Set(['uniqueIndex', 'check']);
const CONSTRAINT_METHODS = new Set(['notNull', 'unique']);

const MESSAGE =
  "Adding a constraint to a SOURCE-tagged table ('{{tableName}}'). Confirm the constraint is consistent with the upstream's data shape (see the SOURCE comment on this table). Suppress with `// eslint-disable-next-line wxyc/source-tagged-constraint-confirmed` once verified.";

/**
 * True if any comment attached above `node` carries the `SOURCE:` marker.
 */
function hasSourceTag(sourceCode, node) {
  const comments = sourceCode.getCommentsBefore(node);
  if (!comments || comments.length === 0) return false;
  return comments.some((c) => SOURCE_TAG_RE.test(c.value));
}

/**
 * Resolve the table-name string passed as the first argument to
 * `<schema>.table('<name>', ...)` or `pgTable('<name>', ...)`.
 * Returns null if it can't be statically determined.
 */
function getTableNameArg(callExpr) {
  const arg0 = callExpr.arguments[0];
  if (!arg0) return null;
  if (arg0.type === 'Literal' && typeof arg0.value === 'string') return arg0.value;
  if (arg0.type === 'TemplateLiteral' && arg0.quasis.length === 1) {
    return arg0.quasis[0].value.cooked;
  }
  return null;
}

/**
 * True if the CallExpression is a Drizzle table definition:
 *   pgTable(...) | someSchema.table(...) | wxyc_schema.table(...)
 */
function isTableDefinitionCall(callExpr) {
  const callee = callExpr.callee;
  if (callee.type === 'Identifier' && callee.name === 'pgTable') return true;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'table'
  ) {
    return true;
  }
  return false;
}

/**
 * Walk up from `node` to find the nearest enclosing CallExpression that
 * is itself a Drizzle table-definition call. Returns null if none found.
 */
function findEnclosingTableDefinition(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'CallExpression' && isTableDefinitionCall(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Warn when a constraint is added to a SOURCE-tagged Drizzle table. SOURCE-tagged tables are downstream of an upstream system; constraints must accept the upstream shape.',
    },
    schema: [],
    messages: {
      sourceTaggedConstraint: MESSAGE,
    },
  },

  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();

    // Cache: a table-definition CallExpression -> "is the surrounding
    // declaration SOURCE-tagged?" The "SOURCE:" comment sits above the
    // outermost `export const X = ...` or `const X = ...`, not above the
    // inner CallExpression, so we walk up to find it.
    const sourceTaggedCache = new WeakMap();

    function tableCallIsSourceTagged(tableCall) {
      if (sourceTaggedCache.has(tableCall)) {
        return sourceTaggedCache.get(tableCall);
      }
      // Comments may attach to any of: VariableDeclarator,
      // VariableDeclaration, ExportNamedDeclaration. Probe each ancestor
      // up to the Program root.
      const candidates = [];
      let current = tableCall.parent;
      while (current && current.type !== 'Program') {
        if (
          current.type === 'VariableDeclaration' ||
          current.type === 'VariableDeclarator' ||
          current.type === 'ExportNamedDeclaration' ||
          current.type === 'ExportDefaultDeclaration'
        ) {
          candidates.push(current);
        }
        current = current.parent;
      }
      const tagged = candidates.some((n) => hasSourceTag(sourceCode, n));
      sourceTaggedCache.set(tableCall, tagged);
      return tagged;
    }

    function reportIfSourceTagged(reportNode, callExpr) {
      const tableCall = findEnclosingTableDefinition(callExpr);
      if (!tableCall) return;
      if (!tableCallIsSourceTagged(tableCall)) return;
      const tableName = getTableNameArg(tableCall) || '<unknown>';
      context.report({
        node: reportNode,
        messageId: 'sourceTaggedConstraint',
        data: { tableName },
      });
    }

    return {
      // Bare-callee form: `uniqueIndex(...)`, `check(...)`. We only fire on
      // an Identifier callee, not on member-expression forms like
      // `obj.uniqueIndex`, which are different APIs.
      "CallExpression[callee.type='Identifier']"(node) {
        if (!CONSTRAINT_CALLEES.has(node.callee.name)) return;
        reportIfSourceTagged(node.callee, node);
      },

      // Member-callee form: `.notNull()`, `.unique()`.
      "CallExpression[callee.type='MemberExpression']"(node) {
        const prop = node.callee.property;
        if (!prop || prop.type !== 'Identifier') return;
        if (!CONSTRAINT_METHODS.has(prop.name)) return;
        reportIfSourceTagged(prop, node);
      },
    };
  },
};

// Registered under the suppress-friendly name so authors confirm with the
// rule name in the disable directive itself.
//
//   // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
//   .notNull()
//
// The disable directive is the confirmation handshake.
module.exports = {
  rules: {
    'source-tagged-constraint-confirmed': rule,
  },
};
