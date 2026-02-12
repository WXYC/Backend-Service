/**
 * Shared database connection pool for tests.
 *
 * Instead of creating a new connection for each test operation,
 * this module provides a shared pool that's created once and reused.
 *
 * Usage:
 *   const { getTestDb, closeTestDb } = require('./utils/db');
 *
 *   const sql = getTestDb();
 *   const result = await sql`SELECT * FROM users`;
 *
 *   // In afterAll or global teardown:
 *   await closeTestDb();
 */

const postgres = require('postgres');

let pool = null;

/**
 * Get the shared test database connection pool.
 * Creates the pool on first call, reuses it on subsequent calls.
 */
function getTestDb() {
  if (!pool) {
    const dbPort = process.env.DB_PORT || 5432;

    pool = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: dbPort,
      database: process.env.DB_NAME,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      max: 5, // Maximum connections in pool
      idle_timeout: 30, // Close idle connections after 30 seconds
      connect_timeout: 10, // Connection timeout in seconds
    });
  }
  return pool;
}

/**
 * Close the shared test database connection pool.
 * Call this in global teardown or afterAll.
 */
async function closeTestDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a query within a transaction that's automatically rolled back.
 * Useful for tests that modify data but shouldn't persist changes.
 *
 * Usage:
 *   await withRollback(async (sql) => {
 *     await sql`INSERT INTO users (name) VALUES ('test')`;
 *     // Changes will be rolled back after this function completes
 *   });
 */
async function withRollback(fn) {
  const sql = getTestDb();
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Error('ROLLBACK'); // Force rollback
    })
    .catch((err) => {
      if (err.message !== 'ROLLBACK') throw err;
    });
}

module.exports = {
  getTestDb,
  closeTestDb,
  withRollback,
};
