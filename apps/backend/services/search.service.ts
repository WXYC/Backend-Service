import { sql, type SQL } from 'drizzle-orm';
import { db, flowsheet, shows, user } from '@wxyc/database';
import { parseSearchQuery, type SearchCondition } from './search-parser.service.js';

export type SearchParams = {
  q: string;
  page: number;
  limit: number;
  sort: 'date' | 'artist' | 'song' | 'dj';
  order: 'asc' | 'desc';
};

type SearchResultRow = {
  id: number;
  play_date: Date;
  artist_name: string | null;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  show_id: number | null;
  dj_name: string | null;
  total: number;
};

export type SearchResult = {
  id: number;
  play_date: string;
  artist_name: string;
  track_title: string;
  album_title: string;
  record_label: string;
  show_id: number;
  dj_name: string;
};

const DJ_NAME_EXPR = sql`COALESCE(${user.djName}, ${shows.legacy_dj_name}, ${user.name}, 'Unknown DJ')`;

const SORT_MAP: Record<SearchParams['sort'], SQL> = {
  date: sql`${flowsheet.add_time}`,
  artist: sql`${flowsheet.artist_name}`,
  song: sql`${flowsheet.track_title}`,
  dj: DJ_NAME_EXPR,
};

/** Column references for WHERE clause building, keyed by SearchField name. */
const COLUMN_MAP: Record<string, SQL> = {
  artist_name: sql`${flowsheet.artist_name}`,
  track_title: sql`${flowsheet.track_title}`,
  album_title: sql`${flowsheet.album_title}`,
  record_label: sql`${flowsheet.record_label}`,
};

/** Search historical flowsheet entries with filtering, sorting, and pagination. */
export async function searchFlowsheet(params: SearchParams): Promise<{ results: SearchResult[]; total: number }> {
  const { q, page, limit, sort, order } = params;
  const offset = page * limit;
  const conditions = parseSearchQuery(q);

  const whereClause = buildWhereClause(conditions);
  const orderDirection = order === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = SORT_MAP[sort];

  const baseFrom = sql`
    FROM ${flowsheet}
    LEFT JOIN ${shows} ON ${shows.id} = ${flowsheet.show_id}
    LEFT JOIN ${user} ON ${user.id} = ${shows.primary_dj_id}
    WHERE ${flowsheet.entry_type} = 'track'
  `;

  const fullWhere = whereClause ? sql`${baseFrom} AND ${whereClause}` : baseFrom;

  const query = sql`
    SELECT
      ${flowsheet.id},
      ${flowsheet.add_time} AS play_date,
      ${flowsheet.artist_name},
      ${flowsheet.track_title},
      ${flowsheet.album_title},
      ${flowsheet.record_label},
      ${flowsheet.show_id},
      ${DJ_NAME_EXPR} AS dj_name,
      COUNT(*)::int OVER() AS total
    ${fullWhere}
    ORDER BY ${sortExpr} ${orderDirection}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const rows = await db.execute(query);

  const typedRows = rows as unknown as SearchResultRow[];
  const results = typedRows.map(transformRow);
  const total = typedRows[0]?.total ?? 0;

  return { results, total };
}

function transformRow(row: SearchResultRow): SearchResult {
  return {
    id: row.id,
    play_date: row.play_date instanceof Date ? row.play_date.toISOString() : String(row.play_date ?? ''),
    artist_name: row.artist_name ?? '',
    track_title: row.track_title ?? '',
    album_title: row.album_title ?? '',
    record_label: row.record_label ?? '',
    show_id: row.show_id ?? 0,
    dj_name: row.dj_name ?? '',
  };
}

function buildWhereClause(conditions: SearchCondition[]): SQL | null {
  if (conditions.length === 0) return null;

  const parts: { operator: 'AND' | 'OR'; fragment: SQL }[] = [];

  for (const condition of conditions) {
    const fragment = buildConditionFragment(condition);
    if (fragment) {
      parts.push({ operator: condition.operator, fragment });
    }
  }

  if (parts.length === 0) return null;

  let result = parts[0].fragment;
  for (let i = 1; i < parts.length; i++) {
    const { operator, fragment } = parts[i];
    if (operator === 'OR') {
      result = sql`${result} OR ${fragment}`;
    } else {
      result = sql`${result} AND ${fragment}`;
    }
  }

  return sql`(${result})`;
}

function buildConditionFragment(condition: SearchCondition): SQL | null {
  const { field, value, exact, negated } = condition;

  let fragment: SQL;

  switch (field) {
    case 'all':
      fragment = buildAllFieldMatch(value, exact);
      break;
    case 'dj_name':
      fragment = buildDjNameMatch(value, exact);
      break;
    case 'add_time':
      fragment = buildDateMatch(value);
      break;
    case 'add_time_range':
      fragment = buildDateRangeMatch(value);
      break;
    default:
      fragment = buildColumnMatch(field, value, exact);
      break;
  }

  return negated ? sql`NOT (${fragment})` : fragment;
}

function buildColumnMatch(column: string, value: string, exact: boolean): SQL {
  const col = COLUMN_MAP[column];
  if (!col) return sql`FALSE`;
  if (exact) {
    return sql`${col} = ${value}`;
  }
  return sql`${col} ILIKE ${'%' + value + '%'}`;
}

function buildAllFieldMatch(value: string, exact: boolean): SQL {
  if (exact) {
    return sql`(${flowsheet.artist_name} = ${value} OR ${flowsheet.track_title} = ${value} OR ${flowsheet.album_title} = ${value} OR ${flowsheet.record_label} = ${value})`;
  }
  const pattern = '%' + value + '%';
  return sql`(${flowsheet.artist_name} ILIKE ${pattern} OR ${flowsheet.track_title} ILIKE ${pattern} OR ${flowsheet.album_title} ILIKE ${pattern} OR ${flowsheet.record_label} ILIKE ${pattern})`;
}

function buildDjNameMatch(value: string, exact: boolean): SQL {
  if (exact) {
    return sql`${DJ_NAME_EXPR} = ${value}`;
  }
  return sql`${DJ_NAME_EXPR} ILIKE ${'%' + value + '%'}`;
}

function buildDateMatch(value: string): SQL {
  return sql`${flowsheet.add_time} >= ${value}::date AND ${flowsheet.add_time} < (${value}::date + interval '1 day')`;
}

function buildDateRangeMatch(value: string): SQL {
  const [start, end] = value.split('..');
  if (!start || !end) {
    return buildDateMatch(value);
  }
  return sql`${flowsheet.add_time} >= ${start}::date AND ${flowsheet.add_time} < (${end}::date + interval '1 day')`;
}
