/**
 * Unit cases for the source-text parsers in `tests/utils/catalog-export-source.ts`. The watermark coverage test
 * is only as strong as these parsers: every shape here is one that once parsed as "unrestricted" or was
 * invisible, so the coverage check failed open (BS#2919 review).
 */

import { exportedColumnsByTable, parseWatermarkTriggers } from '../../utils/catalog-export-source';

const T = 'wxyc_schema.genre_artist_crossreference';
const create = (events: string, name = 'touch_library_watermark_from_gac') =>
  `CREATE TRIGGER ${name} AFTER ${events} ON ${T} FOR EACH STATEMENT EXECUTE FUNCTION wxyc_schema.touch_library_watermark();`;
const drop = (name = 'touch_library_watermark_from_gac') => `DROP TRIGGER IF EXISTS ${name} ON ${T};`;

const parse = (...sqls: string[]) => parseWatermarkTriggers(sqls.map((sql, i) => ({ tag: `m${i}`, sql })));
const latest = (...sqls: string[]) => {
  const t = parse(...sqls).get('genre_artist_crossreference');
  return t && { columns: t.columns, tag: t.tag };
};

describe('parseWatermarkTriggers', () => {
  it.each([
    ['unrestricted UPDATE', create('INSERT OR UPDATE OR DELETE OR TRUNCATE'), null],
    ['UPDATE OF, then DELETE/TRUNCATE', create('INSERT OR UPDATE OF a, b OR DELETE OR TRUNCATE'), ['a', 'b']],
    ['UPDATE OF with no trailing event (a)', create('INSERT OR UPDATE OF a, b'), ['a', 'b']],
    ['UPDATE OF as the only event (a)', create('UPDATE OF a'), ['a']],
    ['UPDATE OF ending before TRUNCATE only (a)', create('UPDATE OF "a", "b" OR TRUNCATE'), ['a', 'b']],
    ['no UPDATE event at all (b)', create('INSERT OR DELETE OR TRUNCATE'), []],
    ['INSERT only (b)', create('INSERT'), []],
  ])('%s', (_label, sql, columns) => {
    expect(latest(sql)?.columns).toEqual(columns);
  });

  it('throws on an event it does not recognize', () => {
    expect(() => latest(create('INSERT OR FROBNICATE'))).toThrow(/FROBNICATE/);
  });

  it('throws on an empty UPDATE OF list', () => {
    expect(() => latest(create('UPDATE OF OR DELETE'))).toThrow();
  });

  it('treats CREATE OR REPLACE TRIGGER as the latest definition (c)', () => {
    const replaced = create('INSERT OR UPDATE OF a OR DELETE').replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER');
    expect(latest(create('INSERT OR UPDATE OR DELETE'), replaced)).toEqual({ columns: ['a'], tag: 'm1' });
  });

  it('removes the entry on a later DISABLE TRIGGER (e)', () => {
    const disable = `ALTER TABLE ${T} DISABLE TRIGGER touch_library_watermark_from_gac;`;
    expect(latest(create('INSERT OR UPDATE OR DELETE'), disable)).toBeUndefined();
  });

  it('restores the definition on a later ENABLE TRIGGER (e)', () => {
    const disable = `ALTER TABLE ${T} DISABLE TRIGGER touch_library_watermark_from_gac;`;
    const enable = `ALTER TABLE ${T} ENABLE ALWAYS TRIGGER touch_library_watermark_from_gac;`;
    expect(latest(create('INSERT OR UPDATE OF a'), disable, enable)).toEqual({ columns: ['a'], tag: 'm0' });
  });

  it('a re-create after DISABLE is enabled again (e)', () => {
    const disable = `ALTER TABLE ${T} DISABLE TRIGGER touch_library_watermark_from_gac;`;
    expect(latest(create('INSERT'), disable, drop(), create('UPDATE'))?.columns).toBeNull();
  });

  it.each([
    ['IF EXISTS', `ALTER TABLE IF EXISTS ${T} DISABLE TRIGGER touch_library_watermark_from_gac;`],
    ['ALL', `ALTER TABLE ${T} DISABLE TRIGGER ALL;`],
    ['USER', `ALTER TABLE ${T} DISABLE TRIGGER USER;`],
    [
      'ENABLE REPLICA',
      `ALTER TABLE ${T} DISABLE TRIGGER touch_library_watermark_from_gac; ALTER TABLE ${T} ENABLE REPLICA TRIGGER touch_library_watermark_from_gac;`,
    ],
    [
      'ENABLE REPLICA after DISABLE ALL',
      `ALTER TABLE ${T} DISABLE TRIGGER ALL; ALTER TABLE ${T} ENABLE REPLICA TRIGGER touch_library_watermark_from_gac;`,
    ],
  ])('counts %s as disabling', (_label, alter) => {
    expect(latest(create('INSERT OR UPDATE OR DELETE'), alter)).toBeUndefined();
  });

  it('ENABLE TRIGGER ALL restores a trigger disabled by DISABLE TRIGGER ALL', () => {
    const got = latest(
      create('INSERT OR UPDATE OF a'),
      `ALTER TABLE ${T} DISABLE TRIGGER ALL; ALTER TABLE ${T} ENABLE TRIGGER ALL;`
    );
    expect(got?.columns).toEqual(['a']);
  });

  it('is not misfiled by a block comment containing ON inside the definition', () => {
    const sql = `CREATE TRIGGER touch_library_watermark_from_gac /* fires ON wxyc_schema.library */ AFTER UPDATE OF a ON ${T} FOR EACH ROW EXECUTE FUNCTION f();`;
    expect(latest(sql)?.columns).toEqual(['a']);
    expect(parse(sql).has('library')).toBe(false);
  });

  it('removes the entry on a later DROP', () => {
    expect(latest(create('UPDATE'), drop())).toBeUndefined();
  });
});

describe('parseWatermarkTriggers WHEN clauses', () => {
  const row = (events: string, when: string) =>
    `CREATE TRIGGER touch_library_watermark_from_gac AFTER ${events} ON ${T} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION wxyc_schema.touch_library_watermark();`;
  it.each([
    ['plain UPDATE narrowed to the referenced column', row('UPDATE', 'OLD.a IS DISTINCT FROM NEW.a'), ['a']],
    ['several references, deduplicated', row('UPDATE', 'OLD.a IS DISTINCT FROM NEW.a OR NEW.b > 1'), ['a', 'b']],
    ['intersected with UPDATE OF', row('UPDATE OF a, b', 'NEW.b IS NOT NULL OR NEW.c IS NOT NULL'), ['b']],
    [
      'quoted columns and nested parens',
      row('UPDATE', '(OLD."a" IS DISTINCT FROM NEW."a") AND lower(NEW.b) = \'x\''),
      ['a', 'b'],
    ],
    ['disjoint from UPDATE OF covers nothing', row('UPDATE OF a', 'NEW.c IS NOT NULL'), []],
    ['no UPDATE event stays empty', row('INSERT OR DELETE', 'NEW.a IS NOT NULL'), []],
  ])('%s', (_label, sql, columns) => {
    expect(latest(sql)?.columns).toEqual(columns);
  });

  it.each([
    ['a bare row comparison', 'OLD IS DISTINCT FROM NEW'],
    ['a row wildcard', 'OLD.* IS DISTINCT FROM NEW.*'],
    ['a condition with no column references', 'true'],
  ])('throws on %s', (_label, when) => {
    expect(() => latest(row('UPDATE', when))).toThrow(/WHEN clause/);
  });
});

describe('exportedColumnsByTable', () => {
  const schema = [
    "export const library = wxyc_schema.table('library', {\n  id: integer('id'),\n  title: text('album_title'),\n});",
    "export const mv = wxyc_schema.materializedView('mv', {\n  n: integer('n'),\n});",
    "export const library_artist_view = wxyc_schema.view('library_artist_view').as(() => 1);",
    "export const user = pgTable('user', {\n  email: text('email'),\n});",
    "export const other = pgTable(\n  'other',\n  {\n    x: text('x'),\n  }\n);",
  ].join('\n');

  it('maps property names to SQL columns for tables and materialized views', () => {
    const got = exportedColumnsByTable('sql`${library.id} ${library.title} ${mv.n}`', schema);
    expect(Object.fromEntries(got)).toEqual({ library: ['album_title', 'id'], mv: ['n'] });
  });

  it.each([
    ['a view (d)', '${library_artist_view.code_comp_letter}'],
    ['a pgTable relation (d)', '${user.email}'],
    ['a multi-line pgTable relation (d)', '${other.x}'],
  ])('throws rather than skipping %s', (_label, source) => {
    expect(() => exportedColumnsByTable(source, schema)).toThrow(/trigger-less|not a wxyc_schema table/);
  });

  it('still skips interpolations that are not schema relations', () => {
    expect(exportedColumnsByTable('${sql.raw} ${someHelper.x}', schema).size).toBe(0);
  });
});
