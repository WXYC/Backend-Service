/**
 * Rendered-SQL pins for `copyCitedCoverReviews` (BS#2875): the select that finds and locks the
 * citing records, the order of the locks and writes, and that both row copies take their column
 * lists from the tables. The real-Postgres behaviour is pinned by
 * `tests/integration/library-delete-cited-review-copy.spec.js`.
 *
 * `jest.unmock('drizzle-orm')` plus a factory that supplies the REAL schema and a never-connected
 * drizzle instance is the mechanism `intake.service.sql.test.ts` documents; `.toSQL()` never executes.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  return { ...realSchema, db: drizzle({}) };
});

import * as fs from 'fs';
import * as path from 'path';
import { getTableColumns } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, review_revisions, reviews } from '@wxyc/database';
import { copyCitedCoverReviews, selectCitingItems } from '../../../apps/backend/services/cited-review-copy.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const dialect = new PgDialect();

type Statement = { kind: string; sql: string; params?: unknown[] };

/**
 * A transaction double over the real query builders: every chained call is forwarded to a real
 * (unconnected) builder, and awaiting one records its rendered SQL and resolves the next queued
 * result for its kind.
 */
const makeTx = (results: { select?: unknown[][]; execute?: unknown[][] }) => {
  const statements: Statement[] = [];
  const queues = { select: [...(results.select ?? [])], execute: [...(results.execute ?? [])], update: [] as [] };
  const wrap = (kind: 'select' | 'update', builder: any): any =>
    new Proxy(builder, {
      get: (target, prop) => {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            statements.push({ kind, sql: target.toSQL().sql });
            resolve(kind === 'select' ? (queues.select.shift() ?? []) : []);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? (...args: unknown[]) => wrap(kind, value.apply(target, args)) : value;
      },
    });
  const tx = {
    select: (...args: unknown[]) => wrap('select', (db.select as any)(...args)),
    update: (...args: unknown[]) => wrap('update', (db.update as any)(...args)),
    execute: (query: any) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      statements.push({ kind: 'execute', sql: text.trim(), params });
      return Promise.resolve(queues.execute.shift() ?? []);
    },
  };
  return { tx: tx as unknown as Parameters<typeof copyCitedCoverReviews>[0], statements };
};

const ITEM: { id: number; album_id: number | null; accepted_review_id: number } = {
  id: 31,
  album_id: null,
  accepted_review_id: 500,
};

describe('selectCitingItems (BS#2875)', () => {
  const rendered = selectCitingItems(db, 42).toSQL().sql.toLowerCase();

  it('finds items whose accepted review belongs to this release through a subquery in the WHERE', () => {
    expect(rendered).toContain(
      `"accepted_review_id" in (select "${SCHEMA}"."reviews"."id" from "${SCHEMA}"."reviews" where "${SCHEMA}"."reviews"."album_id" = $1)`
    );
  });

  it('includes items not yet filed through IS DISTINCT FROM', () => {
    expect(rendered).toContain(`"${SCHEMA}"."intake_items"."album_id" is distinct from $2`);
  });

  it('locks in ascending id order with a plain FOR UPDATE and no OF', () => {
    expect(rendered).toMatch(/order by "[^"]+"\."intake_items"\."id" asc for update$/);
    expect(rendered).not.toContain(' for update of');
  });
});

describe('copyCitedCoverReviews (BS#2875)', () => {
  it('returns after one select when no record took its cover review from this release', async () => {
    const { tx, statements } = makeTx({});

    await copyCitedCoverReviews(tx, 42);

    expect(statements).toHaveLength(1);
    expect(statements[0].sql.toLowerCase()).toContain('for update');
  });

  describe('with one citing record', () => {
    const run = async (item = ITEM) => {
      const harness = makeTx({ select: [[item], [{ id: item.accepted_review_id }]], execute: [[{ id: 900 }]] });
      await copyCitedCoverReviews(harness.tx, 42);
      return harness.statements;
    };

    it('takes FOR SHARE on the reviews to copy, in ascending id, before the first insert', async () => {
      const statements = await run();

      const share = statements.findIndex((s) =>
        s.sql.toLowerCase().endsWith(`order by "${SCHEMA}"."reviews"."id" asc for share`)
      );
      const firstInsert = statements.findIndex((s) => /^\s*insert/i.test(s.sql));
      expect(share).toBe(1);
      expect(firstInsert).toBeGreaterThan(share);
    });

    it('copies the review, then its revisions, then repoints the record, then moves the print log', async () => {
      const statements = await run();

      expect(
        statements.slice(2).map((s) =>
          s.sql
            .match(/^(insert into|update)\s+"[^"]+"\."(\w+)"/i)
            ?.slice(1, 3)
            .join(' ')
            .toLowerCase()
        )
      ).toEqual(['insert into reviews', 'insert into review_revisions', 'update intake_items', 'update review_prints']);
    });

    it.each([
      ['reviews', reviews, ['id', 'intake_item_id', 'album_id']],
      ['review_revisions', review_revisions, ['id', 'review_id']],
    ])('takes the %s copy columns from the table, less its own keys', async (_name, table, omitted) => {
      const statements = await run();
      const insert = statements.find((s) => s.sql.toLowerCase().startsWith(`insert into "${SCHEMA}"."${_name}"`));
      const copied = Object.entries(getTableColumns(table))
        .filter(([key]) => !omitted.includes(key))
        .map(([, column]) => `"${column.name}"`);

      expect(copied.length).toBeGreaterThan(5);
      for (const column of copied) {
        // once in the INSERT list, once in the SELECT list
        expect(insert.sql.split(column).length - 1).toBeGreaterThanOrEqual(2);
      }
    });

    it('stamps the copy with the record and the record’s own album, never the deleted release', async () => {
      const statements = await run({ id: 31, album_id: 77, accepted_review_id: 500 });
      const insert = statements.find((s) => s.sql.toLowerCase().startsWith(`insert into "${SCHEMA}"."reviews"`));

      expect(insert.sql).toContain('(intake_item_id, album_id, ');
      expect(insert.params).toEqual([31, 77, 500]);
    });

    it('does not write accepted_by, accepted_at or state on the record', async () => {
      const statements = await run();
      const update = statements.find((s) => s.sql.startsWith(`update "${SCHEMA}"."intake_items"`));

      expect(update.sql).toContain('"accepted_review_id" = $1');
      expect(update.sql).not.toMatch(/"accepted_by"|"accepted_at"|"state"/);
    });
  });

  it('handles records in ascending id order, one copy each, when two took the same review', async () => {
    const items = [
      { id: 31, album_id: null, accepted_review_id: 500 },
      { id: 32, album_id: null, accepted_review_id: 500 },
    ];
    const { tx, statements } = makeTx({
      select: [items, [{ id: 500 }]],
      execute: [[{ id: 900 }], [], [{ id: 901 }], []],
    });

    await copyCitedCoverReviews(tx, 42);

    expect(statements.filter((s) => s.sql.startsWith(`update "${SCHEMA}"."intake_items"`))).toHaveLength(2);
    expect(statements.filter((s) => s.sql.toLowerCase().includes(`insert into "${SCHEMA}"."reviews"`))).toHaveLength(2);
    // The same review is locked once, not once per record.
    expect(statements.filter((s) => s.sql.endsWith('for share'))).toHaveLength(1);
  });
});

describe('the delete transaction wiring (BS#2875)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../apps/backend/services/library.service.ts'), 'utf-8');
  const body = source.match(/const runDeleteAlbumTransaction[\s\S]*?\n\};/)[0];

  it('runs the copy after the has_digital_assets return and before the capture', () => {
    const refusal = body.indexOf("outcome: 'has_digital_assets'");
    const copy = body.indexOf('await copyCitedCoverReviews(tx, album_id)');
    const capture = body.indexOf('await captureCatalogDeleteSnapshot(');
    expect(refusal).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(refusal);
    expect(capture).toBeGreaterThan(copy);
  });
});
