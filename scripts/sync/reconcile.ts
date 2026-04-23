/**
 * Bidirectional real-time cross-database reconciliation monitor.
 *
 * Connects to BOTH CDC WebSocket endpoints:
 *   - tubafrenzy (MySQL changes) → verifies in Backend-Service PostgreSQL
 *   - Backend-Service (PostgreSQL changes) → verifies in tubafrenzy MySQL
 *
 * On startup, runs a batch comparison of row counts. Then streams CDC events
 * from both sides and cross-checks each one.
 *
 * Usage:
 *   npx tsx scripts/sync/reconcile.ts
 *
 * Environment:
 *   TUBAFRENZY_CDC_URL     tubafrenzy CDC WebSocket URL (default: ws://localhost:8080/cdc)
 *   BACKEND_CDC_URL        Backend-Service CDC WebSocket URL (default: ws://localhost:8080/cdc)
 *   CDC_SECRET             Shared secret for CDC auth (required)
 *   PROPAGATION_DELAY_MS   Delay before checking the other database (default: 5000)
 *   DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD  PostgreSQL connection
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD  MySQL connection
 */

import WebSocket from 'ws';
import postgres from 'postgres';
import mysql from 'mysql2/promise';

// --- Configuration ---

const TUBAFRENZY_CDC_URL = process.env.TUBAFRENZY_CDC_URL ?? 'ws://localhost:8080/cdc';
const BACKEND_CDC_URL = process.env.BACKEND_CDC_URL ?? 'ws://localhost:8080/cdc';
const CDC_SECRET = process.env.CDC_SECRET;
const PROPAGATION_DELAY_MS = Number(process.env.PROPAGATION_DELAY_MS ?? '5000');
const SCHEMA = process.env.WXYC_SCHEMA_NAME ?? 'wxyc_schema';

if (!CDC_SECRET) {
  console.error('CDC_SECRET environment variable is required');
  process.exit(1);
}

const sql = postgres({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? '5432'),
  database: process.env.DB_NAME ?? 'wxyc_db',
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
});

let mysqlPool: mysql.Pool | null = null;

async function getMysql(): Promise<mysql.Pool> {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: process.env.MYSQL_HOST ?? 'localhost',
      port: Number(process.env.MYSQL_PORT ?? '3306'),
      database: process.env.MYSQL_DATABASE ?? 'wxycmusic',
      user: process.env.MYSQL_USER ?? 'root',
      password: process.env.MYSQL_PASSWORD ?? '',
      waitForConnections: true,
      connectionLimit: 2,
    });
  }
  return mysqlPool;
}

// --- Entry type mapping (mirrors Backend-Service's mapProdEntryType) ---

const ENTRY_TYPE_MAP: Record<number, string> = {
  0: 'track', 1: 'track', 2: 'track', 3: 'track',
  4: 'track', 5: 'track', 6: 'track',
  7: 'talkset', 8: 'breakpoint', 9: 'show_start', 10: 'show_end',
};

function mapEntryType(code: number): string {
  return ENTRY_TYPE_MAP[code] ?? 'message';
}

function truncate(s: string | null | undefined, len: number): string {
  if (!s) return '';
  return s.length > len ? s.substring(0, len) : s;
}

function epochMsToDateStr(ms: number): string | null {
  if (!ms || ms === 0) return null;
  return new Date(ms).toISOString().split('T')[0]; // YYYY-MM-DD
}

function epochMsToTimestamp(ms: number): Date | null {
  if (!ms || ms === 0) return null;
  return new Date(ms);
}

// --- Logging ---

function timestamp(): string {
  return new Date().toTimeString().split(' ')[0];
}

function logMatch(table: string, id: number, target: string) {
  console.log(`[${timestamp()}] \x1b[32m✅ ${table} #${id} → ${target} — matched\x1b[0m`);
}

function logMismatch(table: string, id: number, target: string, details: string) {
  console.log(`[${timestamp()}] \x1b[31m❌ ${table} #${id} → ${target} — MISMATCH: ${details}\x1b[0m`);
}

function logMissing(table: string, id: number, target: string) {
  console.log(`[${timestamp()}] \x1b[33m⚠️  ${table} #${id} → ${target} — NOT FOUND\x1b[0m`);
}

function logDeleted(table: string, id: number, target: string, found: boolean) {
  if (!found) {
    console.log(`[${timestamp()}] \x1b[32m🗑️  ${table} #${id} DELETE → ${target} — confirmed deleted\x1b[0m`);
  } else {
    console.log(`[${timestamp()}] \x1b[31m🗑️  ${table} #${id} DELETE → ${target} — STILL EXISTS\x1b[0m`);
  }
}

function logSkipped(table: string, id: number, reason: string) {
  console.log(`[${timestamp()}] \x1b[90m⏭️  ${table} #${id} — ${reason}\x1b[0m`);
}

function logInfo(msg: string) {
  console.log(`[${timestamp()}] \x1b[36mℹ️  ${msg}\x1b[0m`);
}

// --- Field comparison ---

interface FieldDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}

function compareFields(expected: Record<string, unknown>, actual: Record<string, unknown>, fields: string[]): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    const e = expected[field];
    const a = actual[field];
    if (String(e ?? '') !== String(a ?? '')) {
      diffs.push({ field, expected: e, actual: a });
    }
  }
  return diffs;
}

// --- Reconciliation handlers per table ---

type CdcEvent = {
  table: string;
  action: string;
  id: number;
  data: Record<string, unknown> | null;
  timestamp: number;
};

async function reconcileFlowsheetEntry(event: CdcEvent) {
  const { action, id, data } = event;

  if (action === 'DELETE') {
    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.flowsheet WHERE legacy_entry_id = ${id}`;
    logDeleted('FLOWSHEET_ENTRY_PROD', id, 'flowsheet', rows.length > 0);
    return;
  }

  if (!data) return;

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.flowsheet WHERE legacy_entry_id = ${id}`;
  if (rows.length === 0) {
    logMissing('FLOWSHEET_ENTRY_PROD', id, 'flowsheet');
    return;
  }

  const row = rows[0];
  const entryType = mapEntryType(Number(data.flowsheetEntryType ?? 0));
  const isStructural = ['talkset', 'breakpoint', 'show_start', 'show_end', 'message'].includes(entryType);

  const expected: Record<string, unknown> = {
    entry_type: entryType,
    play_order: data.sequenceWithinShow,
  };

  if (isStructural) {
    expected.message = truncate(String(data.artistName ?? ''), 250);
  } else {
    expected.artist_name = truncate(String(data.artistName ?? ''), 128);
    expected.track_title = truncate(String(data.songTitle ?? ''), 128);
    expected.album_title = truncate(String(data.releaseTitle ?? ''), 128);
    expected.record_label = truncate(String(data.labelName ?? ''), 128);
  }

  const fieldsToCompare = isStructural
    ? ['entry_type', 'play_order']
    : ['entry_type', 'artist_name', 'track_title', 'album_title', 'record_label', 'play_order'];

  const diffs = compareFields(expected, row, fieldsToCompare);

  if (diffs.length === 0) {
    logMatch('FLOWSHEET_ENTRY_PROD', id, 'flowsheet');
  } else {
    const details = diffs.map(d => `${d.field}: "${d.expected}" vs "${d.actual}"`).join(', ');
    logMismatch('FLOWSHEET_ENTRY_PROD', id, 'flowsheet', details);
  }
}

async function reconcileRadioShow(event: CdcEvent) {
  const { action, id, data } = event;

  if (action === 'DELETE' || !data) {
    logSkipped('FLOWSHEET_RADIO_SHOW_PROD', id, 'shows are not deleted');
    return;
  }

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.shows WHERE legacy_show_id = ${id}`;
  if (rows.length === 0) {
    logMissing('FLOWSHEET_RADIO_SHOW_PROD', id, 'shows');
    return;
  }

  const row = rows[0];
  const diffs: FieldDiff[] = [];

  const expectedDjName = String(data.djName ?? '');
  if (expectedDjName && row.legacy_dj_name && expectedDjName !== String(row.legacy_dj_name)) {
    diffs.push({ field: 'dj_name', expected: expectedDjName, actual: row.legacy_dj_name });
  }

  if (diffs.length === 0) {
    logMatch('FLOWSHEET_RADIO_SHOW_PROD', id, 'shows');
  } else {
    const details = diffs.map(d => `${d.field}: "${d.expected}" vs "${d.actual}"`).join(', ');
    logMismatch('FLOWSHEET_RADIO_SHOW_PROD', id, 'shows', details);
  }
}

async function reconcileRotation(event: CdcEvent) {
  const { action, id, data } = event;

  if (action === 'DELETE') {
    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.rotation WHERE legacy_rotation_id = ${id}`;
    logDeleted('ROTATION_RELEASE', id, 'rotation', rows.length > 0);
    return;
  }

  if (!data) return;

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.rotation WHERE legacy_rotation_id = ${id}`;
  if (rows.length === 0) {
    logMissing('ROTATION_RELEASE', id, 'rotation');
    return;
  }

  const row = rows[0];
  const diffs: FieldDiff[] = [];

  const expectedBin = String(data.rotationType ?? '');
  if (expectedBin && expectedBin !== String(row.rotation_bin ?? '')) {
    diffs.push({ field: 'rotation_bin', expected: expectedBin, actual: row.rotation_bin });
  }

  const expectedKillDate = epochMsToDateStr(Number(data.killDate ?? 0));
  const actualKillDate = row.kill_date ? String(row.kill_date).split('T')[0] : null;
  if (expectedKillDate !== actualKillDate) {
    diffs.push({ field: 'kill_date', expected: expectedKillDate, actual: actualKillDate });
  }

  if (diffs.length === 0) {
    logMatch('ROTATION_RELEASE', id, 'rotation');
  } else {
    const details = diffs.map(d => `${d.field}: "${d.expected}" vs "${d.actual}"`).join(', ');
    logMismatch('ROTATION_RELEASE', id, 'rotation', details);
  }
}

async function reconcileLibraryRelease(event: CdcEvent) {
  const { action, id, data } = event;

  if (action === 'DELETE') {
    const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.library WHERE legacy_release_id = ${id}`;
    logDeleted('LIBRARY_RELEASE', id, 'library', rows.length > 0);
    return;
  }

  if (!data) return;

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.library WHERE legacy_release_id = ${id}`;
  if (rows.length === 0) {
    logMissing('LIBRARY_RELEASE', id, 'library');
    return;
  }

  const row = rows[0];
  const expectedTitle = truncate(String(data.title ?? ''), 128);
  const actualTitle = String(row.album_title ?? '');

  if (expectedTitle === actualTitle) {
    logMatch('LIBRARY_RELEASE', id, 'library');
  } else {
    logMismatch('LIBRARY_RELEASE', id, 'library', `album_title: "${expectedTitle}" vs "${actualTitle}"`);
  }
}

async function reconcileLibraryCode(event: CdcEvent) {
  const { action, id, data } = event;
  if (action === 'DELETE' || !data) {
    logSkipped('LIBRARY_CODE', id, action === 'DELETE' ? 'delete not synced' : 'no data');
    return;
  }

  const name = String(data.presentationName ?? '');
  const letters = String(data.callLetters ?? '');
  if (!name) {
    logSkipped('LIBRARY_CODE', id, 'empty presentation name');
    return;
  }

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.artists WHERE artist_name = ${name} AND code_letters = ${letters}`;
  if (rows.length === 0) {
    logMissing('LIBRARY_CODE', id, `artists (${name} / ${letters})`);
  } else {
    logMatch('LIBRARY_CODE', id, `artists (${name} / ${letters})`);
  }
}

async function reconcileCompany(event: CdcEvent) {
  const { action, id, data } = event;
  if (action === 'DELETE' || !data) {
    logSkipped('COMPANY', id, action === 'DELETE' ? 'delete not synced' : 'no data');
    return;
  }

  const name = String(data.name ?? '');
  if (!name) {
    logSkipped('COMPANY', id, 'empty name');
    return;
  }

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.labels WHERE label_name = ${name}`;
  if (rows.length === 0) {
    logMissing('COMPANY', id, `labels ("${name}")`);
  } else {
    logMatch('COMPANY', id, `labels ("${name}")`);
  }
}

async function reconcileFormat(event: CdcEvent) {
  if (!event.data) return;
  const name = String(event.data.referenceName ?? event.data.formatName ?? '');
  if (!name) return;

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.format WHERE format_name = ${name}`;
  if (rows.length === 0) {
    logMissing('FORMAT', event.id, `format ("${name}")`);
  } else {
    logMatch('FORMAT', event.id, `format ("${name}")`);
  }
}

async function reconcileGenre(event: CdcEvent) {
  if (!event.data) return;
  const name = String(event.data.referenceName ?? event.data.genreName ?? '');
  if (!name) return;

  const rows = await sql`SELECT * FROM ${sql(SCHEMA)}.genres WHERE genre_name = ${name}`;
  if (rows.length === 0) {
    logMissing('GENRE', event.id, `genres ("${name}")`);
  } else {
    logMatch('GENRE', event.id, `genres ("${name}")`);
  }
}

// --- Reverse direction: Backend-Service → check tubafrenzy MySQL ---

async function reverseReconcileFlowsheet(event: CdcEvent) {
  const { action, data } = event;
  if (!data) return;

  const legacyId = data.legacy_entry_id as number | null;
  if (!legacyId) {
    logSkipped('flowsheet', 0, 'no legacy_entry_id (Backend-Service native)');
    return;
  }

  const pool = await getMysql();
  if (action === 'DELETE') {
    const [rows] = await pool.query('SELECT ID FROM FLOWSHEET_ENTRY_PROD WHERE ID = ?', [legacyId]);
    logDeleted('flowsheet', legacyId, 'FLOWSHEET_ENTRY_PROD', (rows as any[]).length > 0);
    return;
  }

  const [rows] = await pool.query('SELECT * FROM FLOWSHEET_ENTRY_PROD WHERE ID = ?', [legacyId]);
  if ((rows as any[]).length === 0) {
    logMissing('flowsheet', legacyId, 'FLOWSHEET_ENTRY_PROD');
    return;
  }

  const row = (rows as any[])[0];
  const diffs: FieldDiff[] = [];
  const artistName = String(data.artist_name ?? data.message ?? '');
  const mysqlArtist = String(row.ARTIST_NAME ?? '');
  if (artistName && mysqlArtist && truncate(mysqlArtist, 128) !== truncate(artistName, 128)) {
    diffs.push({ field: 'artist_name', expected: artistName, actual: mysqlArtist });
  }

  if (diffs.length === 0) {
    logMatch('flowsheet', legacyId, 'FLOWSHEET_ENTRY_PROD');
  } else {
    const details = diffs.map(d => `${d.field}: "${d.expected}" vs "${d.actual}"`).join(', ');
    logMismatch('flowsheet', legacyId, 'FLOWSHEET_ENTRY_PROD', details);
  }
}

async function reverseReconcileShows(event: CdcEvent) {
  const { data } = event;
  if (!data) return;

  const legacyId = data.legacy_show_id as number | null;
  if (!legacyId) {
    logSkipped('shows', 0, 'no legacy_show_id');
    return;
  }

  const pool = await getMysql();
  const [rows] = await pool.query('SELECT * FROM FLOWSHEET_RADIO_SHOW_PROD WHERE ID = ?', [legacyId]);
  if ((rows as any[]).length === 0) {
    logMissing('shows', legacyId, 'FLOWSHEET_RADIO_SHOW_PROD');
  } else {
    logMatch('shows', legacyId, 'FLOWSHEET_RADIO_SHOW_PROD');
  }
}

async function reverseReconcileRotation(event: CdcEvent) {
  const { data } = event;
  if (!data) return;

  const legacyId = data.legacy_rotation_id as number | null;
  if (!legacyId) {
    logSkipped('rotation', 0, 'no legacy_rotation_id');
    return;
  }

  const pool = await getMysql();
  const [rows] = await pool.query('SELECT * FROM ROTATION_RELEASE WHERE ID = ?', [legacyId]);
  if ((rows as any[]).length === 0) {
    logMissing('rotation', legacyId, 'ROTATION_RELEASE');
  } else {
    logMatch('rotation', legacyId, 'ROTATION_RELEASE');
  }
}

async function reverseReconcileLibrary(event: CdcEvent) {
  const { data } = event;
  if (!data) return;

  const legacyId = data.legacy_release_id as number | null;
  if (!legacyId) {
    logSkipped('library', 0, 'no legacy_release_id');
    return;
  }

  const pool = await getMysql();
  const [rows] = await pool.query('SELECT * FROM LIBRARY_RELEASE WHERE ID = ?', [legacyId]);
  if ((rows as any[]).length === 0) {
    logMissing('library', legacyId, 'LIBRARY_RELEASE');
  } else {
    logMatch('library', legacyId, 'LIBRARY_RELEASE');
  }
}

// --- Table routing ---

// Forward: tubafrenzy CDC → check PostgreSQL
const TUBAFRENZY_TABLES: Record<string, (event: CdcEvent) => Promise<void>> = {
  FLOWSHEET_ENTRY_PROD: reconcileFlowsheetEntry,
  FLOWSHEET_RADIO_SHOW_PROD: reconcileRadioShow,
  ROTATION_RELEASE: reconcileRotation,
  LIBRARY_RELEASE: reconcileLibraryRelease,
  LIBRARY_CODE: reconcileLibraryCode,
  COMPANY: reconcileCompany,
  FORMAT: reconcileFormat,
  GENRE: reconcileGenre,
};

// Reverse: Backend-Service CDC → check MySQL
const BACKEND_TABLES: Record<string, (event: CdcEvent) => Promise<void>> = {
  flowsheet: reverseReconcileFlowsheet,
  shows: reverseReconcileShows,
  rotation: reverseReconcileRotation,
  library: reverseReconcileLibrary,
};

const UNSYNCED_TABLES = new Set([
  'COMMENT', 'USER', 'WEEKLY_PLAY', 'APPLICATION_VARIABLE',
  'LIBRARY_CODE_CROSS_REFERENCE', 'RELEASE_CROSS_REFERENCE',
  // Backend-Service tables with no tubafrenzy counterpart
  'auth_user', 'auth_account', 'auth_organization', 'auth_member',
  'auth_invitation', 'user_activity', 'anonymous_devices',
  'dj_stats', 'schedule', 'shift_covers', 'cronjob_runs', 'bins',
  'reviews', 'specialty_shows', 'show_djs', 'compilation_track_artist',
  'genre_artist_crossreference', 'artist_library_crossreference',
  'artist_crossreference',
]);

// --- Batch reconciliation (startup) ---

async function batchReconcile() {
  console.log('\n' + '='.repeat(60));
  logInfo('Batch reconciliation — comparing row counts');
  console.log('='.repeat(60));

  const counts = [
    { mysql: 'FLOWSHEET_ENTRY_PROD', pg: 'flowsheet', key: 'legacy_entry_id' },
    { mysql: 'FLOWSHEET_RADIO_SHOW_PROD', pg: 'shows', key: 'legacy_show_id' },
    { mysql: 'ROTATION_RELEASE', pg: 'rotation', key: 'legacy_rotation_id' },
    { mysql: 'LIBRARY_RELEASE', pg: 'library', key: 'legacy_release_id' },
  ];

  for (const { mysql, pg, key } of counts) {
    const result = await sql`
      SELECT
        count(*) as total,
        count(${sql(key)}) as with_legacy_id
      FROM ${sql(SCHEMA)}.${sql(pg)}
    `;
    const { total, with_legacy_id } = result[0];
    console.log(`  ${pg}: ${total} rows (${with_legacy_id} with ${key})`);
  }

  // Check for recent entries in PostgreSQL that might be missing legacy IDs
  const orphans = await sql`
    SELECT count(*) as count
    FROM ${sql(SCHEMA)}.flowsheet
    WHERE legacy_entry_id IS NULL
      AND add_time > NOW() - INTERVAL '24 hours'
  `;
  if (Number(orphans[0].count) > 0) {
    logInfo(`${orphans[0].count} flowsheet entries from last 24h have no legacy_entry_id (Backend-Service native)`);
  }

  console.log('');
}

// --- WebSocket CDC client (generic, used for both directions) ---

function connectCdc(
  label: string,
  wsUrl: string,
  tableHandlers: Record<string, (event: CdcEvent) => Promise<void>>,
) {
  const url = `${wsUrl}?key=${CDC_SECRET}`;
  logInfo(`[${label}] Connecting to ${wsUrl}...`);

  const ws = new WebSocket(url);
  let reconnectDelay = 1000;

  ws.on('open', () => {
    logInfo(`[${label}] Connected`);
    reconnectDelay = 1000;
  });

  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'heartbeat' || msg.type === 'connected') {
        if (msg.type === 'connected') {
          logInfo(`[${label}] Server time: ${new Date(msg.serverTime).toISOString()}`);
        }
        return;
      }

      const event = msg as CdcEvent;
      const handler = tableHandlers[event.table];

      if (handler) {
        await new Promise(resolve => setTimeout(resolve, PROPAGATION_DELAY_MS));
        await handler(event);
      } else if (!UNSYNCED_TABLES.has(event.table)) {
        logSkipped(event.table, event.id ?? 0, `[${label}] unknown table`);
      }
    } catch (err) {
      console.error(`[${timestamp()}] [${label}] Error processing CDC event:`, err);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.error(`[${timestamp()}] [${label}] WebSocket closed: ${code} ${reason.toString()}`);
    logInfo(`[${label}] Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(() => connectCdc(label, wsUrl, tableHandlers), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (err: Error) => {
    console.error(`[${timestamp()}] [${label}] WebSocket error:`, err.message);
  });
}

// --- Main ---

async function main() {
  console.log('🔍 WXYC Bidirectional Reconciliation Monitor');
  console.log(`   tubafrenzy CDC: ${TUBAFRENZY_CDC_URL}`);
  console.log(`   Backend-Service CDC: ${BACKEND_CDC_URL}`);
  console.log(`   PostgreSQL: ${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'wxyc_db'}`);
  console.log(`   MySQL: ${process.env.MYSQL_HOST ?? 'localhost'}:${process.env.MYSQL_PORT ?? '3306'}/${process.env.MYSQL_DATABASE ?? 'wxycmusic'}`);
  console.log(`   Propagation delay: ${PROPAGATION_DELAY_MS}ms`);
  console.log('');

  // Verify PostgreSQL connection
  try {
    await sql`SELECT 1`;
    logInfo('PostgreSQL connection OK');
  } catch (err) {
    console.error('Failed to connect to PostgreSQL:', err);
    process.exit(1);
  }

  // Verify MySQL connection
  try {
    const pool = await getMysql();
    await pool.query('SELECT 1');
    logInfo('MySQL connection OK');
  } catch (err) {
    console.error('Failed to connect to MySQL:', err);
    process.exit(1);
  }

  await batchReconcile();

  console.log('\n' + '='.repeat(60));
  logInfo('Streaming — bidirectional monitoring');
  console.log('='.repeat(60) + '\n');

  // Forward: tubafrenzy changes → check PostgreSQL
  connectCdc('tubafrenzy→PG', TUBAFRENZY_CDC_URL, TUBAFRENZY_TABLES);

  // Reverse: Backend-Service changes → check MySQL
  connectCdc('PG→tubafrenzy', BACKEND_CDC_URL, BACKEND_TABLES);

  // Graceful shutdown
  const shutdown = async () => {
    logInfo('Shutting down...');
    await sql.end();
    if (mysqlPool) await mysqlPool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
