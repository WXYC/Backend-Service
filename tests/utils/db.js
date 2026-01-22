/**
 * Database Connection Pool for Tests
 *
 * Provides a shared connection pool to avoid per-test connection overhead.
 */

const postgres = require('postgres');

let pool = null;

/**
 * Get or create the test database connection pool
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
      max: 10, // Maximum connections in pool
      idle_timeout: 20, // Close idle connections after 20 seconds
      connect_timeout: 10, // Connection timeout
    });
  }
  return pool;
}

/**
 * Close the test database connection pool
 * Call this in afterAll() for cleanup
 */
async function closeTestDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Reset test data to a known state
 * Useful for test isolation
 */
async function resetTestData() {
  const sql = getTestDb();

  // Delete test-generated data while preserving seed data
  // This is a template - adjust based on your test needs
  await sql`
    DELETE FROM flowsheet
    WHERE id > 1000
    OR album_title LIKE 'TEST_%'
  `;
}

module.exports = {
  getTestDb,
  closeTestDb,
  resetTestData,
};
