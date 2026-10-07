/**
 * @fileoverview Flags an insert into the `library` or `rotation` table outside
 * an allow-list of named functions and directories (BS#2808, slice 15b of
 * BS#2791).
 *
 * ## Why
 *
 * Slice 15 (BS#2807) put the review gate inside `insertAlbum` and
 * `addToRotation`: a release enters the catalog or a rotation bin only with a
 * review-gate basis. Nothing stopped a later change from inserting some other
 * way and walking around the gate. This rule makes that a CI failure.
 *
 * ## What it matches
 *
 *   - A Drizzle `<anything>.insert(library)` / `.insert(rotation)` (also
 *     `.insert(schema.library)`).
 *   - A `sql` tagged template whose literal text contains
 *     `INSERT INTO library` / `INSERT INTO rotation`, optionally
 *     schema-qualified (`wxyc_schema.rotation`) or double-quoted. Names that
 *     merely start with the table name (`library_identity`) do not match.
 *
 * An interpolated table (`` sql`INSERT INTO ${table} ...` ``) is not
 * resolved: the rule cannot know which table the identifier names, so it
 * stays silent, by construction. `replayCapturedRows` is such a site, and its
 * allow-list entry is documentation only.
 *
 * ## Allow-list granularity: functions, not files
 *
 * `restricted-real-name` exempts whole files. Here that would exempt
 * `apps/backend/services/library.service.ts`, the file most likely to grow a
 * new insert. So an entry is either a directory (trailing `/`, every file
 * under it) or a file with a list of top-level declaration names.
 *
 * The name compared is the TOP-LEVEL declaration enclosing the insert: the
 * `FunctionDeclaration`, or the module-scope `const`/`let` `VariableDeclarator`
 * (exported or not). Never the nearest function. Both gated inserts run in an
 * inner `const run = async (tx) => { ... }` closure (BS#2988), and allow-listing
 * `run` would exempt every function in the file that happens to name its
 * closure `run`.
 *
 * Test files are out of scope (the config does not apply the rule to
 * `tests/**`), as for `restricted-real-name`.
 */

'use strict';

const path = require('path');

const RESTRICTED_TABLES = new Set(['library', 'rotation']);

// Repo-root-relative. A trailing "/" is a directory prefix (whole directory
// allowed); otherwise the entry is an exact file and `names` lists the
// top-level declarations in it that may insert.
const ALLOW_LIST = [
  {
    file: 'apps/backend/services/library.service.ts',
    // `replayCapturedRows` inserts through an interpolated table the rule
    // cannot see; it is listed so the intent is on record.
    names: ['insertAlbum', 'addToRotation', 'replayCapturedRows'],
  },
  // The legacy tubafrenzy ETLs.
  { dir: 'jobs/library-etl/' },
  { dir: 'jobs/rotation-etl/' },
];

const MESSAGE =
  "Insert into '{{table}}' outside the allow-list (enclosing declaration: {{enclosing}}). Rows enter library and rotation only through insertAlbum / addToRotation, which carry the review gate. Go through them, or argue this site onto ALLOW_LIST in eslint-rules/restricted-library-rotation-insert.cjs.";

// `INSERT INTO [schema.]library`, with optional double quotes, a `${...}`
// schema prefix (rendered as NUL), and a boundary that rejects longer names.
const RAW_INSERT = /insert\s+into\s+(?:(?:"?\w+"?|\0)\.)?"?(library|rotation)(?:"|(?!\w))/i;

function toRepoRelativePath(filename, cwd) {
  return path.relative(cwd, path.resolve(cwd, filename)).split(path.sep).join('/');
}

/**
 * The name of the top-level declaration containing `node`, or null when the
 * enclosing top-level statement is not a named function or a `const`/`let`
 * declarator (a class, a bare statement), which no allow-list entry can name.
 */
function topLevelName(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    const atTop =
      parent.type === 'Program' ||
      ((parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') &&
        parent.parent.type === 'Program');
    if (atTop) {
      if (current.type === 'FunctionDeclaration' && current.id) return current.id.name;
      if (current.type === 'VariableDeclaration') {
        // The declarator on the path to `node`, not merely the first one.
        const declarator = current.declarations.find((d) => d.range[0] <= node.range[0] && node.range[1] <= d.range[1]);
        if (declarator && declarator.id.type === 'Identifier') return declarator.id.name;
      }
      return null;
    }
    current = parent;
  }
  return null;
}

function isAllowed(relativePath, enclosing) {
  return ALLOW_LIST.some((entry) => {
    if (entry.dir) return relativePath.startsWith(entry.dir);
    return entry.file === relativePath && enclosing !== null && entry.names.includes(enclosing);
  });
}

function tableNameOf(arg) {
  if (!arg) return null;
  const name =
    arg.type === 'Identifier'
      ? arg.name
      : arg.type === 'MemberExpression' && !arg.computed && arg.property.type === 'Identifier'
        ? arg.property.name
        : null;
  return name !== null && RESTRICTED_TABLES.has(name) ? name : null;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow inserting into `library` or `rotation` outside the gated insert functions (insertAlbum, addToRotation) and the legacy ETL jobs.',
    },
    schema: [],
    messages: { restrictedInsert: MESSAGE },
  },

  create(context) {
    const relativePath = toRepoRelativePath(context.filename, context.cwd);

    function check(node, table) {
      const enclosing = topLevelName(node);
      if (isAllowed(relativePath, enclosing)) return;
      context.report({
        node,
        messageId: 'restrictedInsert',
        data: { table, enclosing: enclosing ?? 'none' },
      });
    }

    return {
      // `tx.insert(rotation)`, `db.insert(schema.library)`.
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'insert') return;
        const table = tableNameOf(node.arguments[0]);
        if (table) check(node, table);
      },

      // `sql\`INSERT INTO library ...\``: match on the literal text only, with
      // `${...}` rendered as NUL so an interpolated table never matches.
      TaggedTemplateExpression(node) {
        const tag = node.tag;
        const isSqlTag =
          tag.type === 'Identifier'
            ? tag.name === 'sql'
            : tag.type === 'MemberExpression' &&
              !tag.computed &&
              tag.property.type === 'Identifier' &&
              tag.property.name === 'sql';
        if (!isSqlTag) return;
        const text = node.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw).join('\0');
        const match = RAW_INSERT.exec(text);
        if (match) check(node, match[1].toLowerCase());
      },
    };
  },
};

module.exports = {
  rules: {
    'restricted-library-rotation-insert': rule,
  },
};
