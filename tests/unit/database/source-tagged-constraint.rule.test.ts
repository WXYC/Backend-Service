/**
 * Tests for the wxyc/source-tagged-constraint-confirmed ESLint rule.
 *
 * The rule warns when a constraint (uniqueIndex / check / .notNull() /
 * .unique()) is added to a Drizzle table whose definition is preceded by a
 * `SOURCE:` comment. The intent is to nudge authors to confirm the new
 * constraint is consistent with the upstream system's data shape before
 * shipping it. See WXYC/Backend-Service#702.
 */
import { RuleTester } from 'eslint';

// The rule plugin lives at `eslint-rules/source-tagged-constraint.cjs`. The
// CommonJS extension is deliberate so the same module loads from
// `eslint.config.mjs` (via ESM default-import interop) and from these
// ts-jest-compiled tests (which run under CommonJS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wxycLocalRules = require('../../../eslint-rules/source-tagged-constraint.cjs') as {
  rules: { 'source-tagged-constraint-confirmed': unknown };
};

const rule = wxycLocalRules.rules['source-tagged-constraint-confirmed'];

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('source-tagged-constraint-confirmed', rule, {
  valid: [
    // No SOURCE comment — constraints anywhere are fine.
    {
      code: `
        export const widgets = wxyc_schema.table(
          'widgets',
          {
            id: serial('id').primaryKey(),
            name: varchar('name').notNull(),
          },
          (table) => [uniqueIndex('widgets_name_idx').on(table.name)]
        );
      `,
    },
    // SOURCE-tagged but no constraints in the body.
    {
      code: `
        /**
         * SOURCE: tubafrenzy via the rotation-etl. The music director
         * writes here.
         */
        export const rotation = wxyc_schema.table('rotation', {
          id: serial('id').primaryKey(),
          rotation_bin: freqEnum('rotation_bin'),
        });
      `,
    },
    // SOURCE-tagged with constraints, but each is suppressed via inline
    // disable directive.
    {
      code: `
        /**
         * SOURCE: tubafrenzy via the rotation-etl.
         */
        export const rotation = wxyc_schema.table(
          'rotation',
          {
            id: serial('id').primaryKey(),
            // eslint-disable-next-line rule-to-test/source-tagged-constraint-confirmed
            rotation_bin: freqEnum('rotation_bin').notNull(),
          },
          (table) => [
            // eslint-disable-next-line rule-to-test/source-tagged-constraint-confirmed
            uniqueIndex('rotation_legacy_id_idx').on(table.legacy_id),
          ]
        );
      `,
    },
    // Bare-const (no `export`) form — comment attaches to the
    // VariableDeclaration directly. Suppress directive matches.
    {
      code: `
        /** SOURCE: legacy MySQL via library-etl. */
        const library = wxyc_schema.table('library', {
          id: serial('id').primaryKey(),
          // eslint-disable-next-line rule-to-test/source-tagged-constraint-confirmed
          album_title: varchar('album_title').notNull(),
        });
      `,
    },
  ],

  invalid: [
    // Hostile constraint: `.notNull()` on a SOURCE-tagged column tubafrenzy
    // permits NULL.
    {
      code: `
        /**
         * SOURCE: tubafrenzy via the rotation-etl. NULL album_id is
         * permitted upstream.
         */
        export const rotation = wxyc_schema.table('rotation', {
          id: serial('id').primaryKey(),
          album_id: integer('album_id').notNull(),
        });
      `,
      errors: [
        {
          messageId: 'sourceTaggedConstraint',
          data: { tableName: 'rotation' },
        },
      ],
    },
    // Hostile constraint: a partial `uniqueIndex` on (album_id, bin) that
    // contradicts tubafrenzy's "multiple rows per (album, bin) over an
    // album lifecycle" invariant. This is the exact PR #696 regression.
    {
      code: `
        /** SOURCE: tubafrenzy via rotation-etl. */
        export const rotation = wxyc_schema.table(
          'rotation',
          {
            id: serial('id').primaryKey(),
            album_id: integer('album_id'),
            rotation_bin: text('rotation_bin'),
            kill_date: date('kill_date'),
          },
          (table) => [
            uniqueIndex('rotation_album_bin_unique')
              .on(table.album_id, table.rotation_bin)
              .where(\`\${table.kill_date} IS NULL\`),
          ]
        );
      `,
      errors: [{ messageId: 'sourceTaggedConstraint' }],
    },
    // Hostile constraint: a `check()` on a SOURCE-tagged table. The
    // upstream may write rows that violate the check.
    {
      code: `
        /** SOURCE: legacy MySQL via library-etl. */
        export const library = wxyc_schema.table(
          'library',
          {
            id: serial('id').primaryKey(),
            plays: integer('plays'),
          },
          (table) => [check('plays_positive', \`\${table.plays} > 0\`)]
        );
      `,
      errors: [{ messageId: 'sourceTaggedConstraint' }],
    },
    // SOURCE-tagged with multiple unconfirmed constraints — one warning
    // per constraint.
    {
      code: `
        /** SOURCE: tubafrenzy webhook + flowsheet-etl. */
        export const flowsheet = wxyc_schema.table(
          'flowsheet',
          {
            id: serial('id').primaryKey(),
            entry_type: text('entry_type').notNull(),
            play_order: integer('play_order').notNull(),
          }
        );
      `,
      errors: [
        { messageId: 'sourceTaggedConstraint', data: { tableName: 'flowsheet' } },
        { messageId: 'sourceTaggedConstraint', data: { tableName: 'flowsheet' } },
      ],
    },
    // pgTable-form (auth tables don't use this, but the rule should still
    // fire on the form).
    {
      code: `
        /** SOURCE: external system. */
        export const externalThing = pgTable('external_thing', {
          id: varchar('id').primaryKey(),
          name: varchar('name').notNull(),
        });
      `,
      errors: [{ messageId: 'sourceTaggedConstraint', data: { tableName: 'external_thing' } }],
    },
  ],
});
