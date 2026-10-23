/**
 * Drift guard for the one list of `labels.id` references (BS#3289). The counts read and the delete guard both walk
 * `LABEL_REFERENCES`, so a table that gains a `references(() => labels.id)` and is not named there would be invisible to
 * both: a label could be deleted out from under it. Reads the schema source as text; the second test fails on a `labels.id`
 * mention in any shape the scan does not recognise.
 */
jest.unmock('drizzle-orm');
jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

import { getTableName } from 'drizzle-orm';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LABEL_REFERENCES } from '../../../apps/backend/services/label-references';

const SCHEMA_DIR = path.resolve(__dirname, '../../../shared/database/src');

const schemaSources = readdirSync(SCHEMA_DIR)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));

/** Every `<key>: type('<column>')....references(() => labels.id)` in the schema, as `table.column`. */
const declaredReferences = (): string[] =>
  schemaSources.flatMap((source) =>
    [...source.matchAll(/\w+\(\s*'(\w+)'[^)]*\)\s*\.references\(\s*\(\)\s*=>\s*labels\.id/g)].map((match) => {
      const tableMatches = [...source.slice(0, match.index).matchAll(/\.table\(\s*'(\w+)'/g)];
      return `${tableMatches[tableMatches.length - 1][1]}.${match[1]}`;
    })
  );

describe('LABEL_REFERENCES', () => {
  it('names every column the schema declares as a reference to labels.id', () => {
    const listed = LABEL_REFERENCES.map((ref) => `${getTableName(ref.table)}.${ref.fkColumn.name}`);
    expect(declaredReferences().sort()).toEqual(listed.sort());
  });

  it('sees every mention of labels.id as a reference this scan understands', () => {
    const mentions = schemaSources.reduce((sum, source) => sum + (source.match(/\blabels\.id\b/g) ?? []).length, 0);
    expect(mentions).toBe(declaredReferences().length);
  });

  it('has a distinct source key per entry, matching the wire vocabulary', () => {
    expect(LABEL_REFERENCES.map((ref) => ref.source)).toEqual(['library', 'rotation', 'flowsheet', 'intake_items']);
  });
});
