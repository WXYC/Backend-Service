const { readFileSync } = require('fs');
const path = require('path');
const postgres = require('postgres');
const waitOn = require('wait-on');

/**
 * Load the shape fixture (tests/fixtures/shape.sql) into the per-worker
 * schema. Called after services are confirmed ready and before any
 * integration spec runs. Idempotent: every INSERT carries
 * `ON CONFLICT (id) DO NOTHING` so re-running the fixture against an
 * already-populated schema is a no-op.
 *
 * The schema name is read from `WXYC_SCHEMA_NAME` so the fixture lands
 * in the same per-worker schema the application code reads. The
 * migrations themselves hardcode `wxyc_schema`, so today this always
 * resolves to `wxyc_schema` in CI; the env var is honored for
 * forward-compatibility with the parallel-worker isolation roadmap.
 *
 * Conflict targets are deliberately scoped to the primary key
 * (`ON CONFLICT (id) DO NOTHING`) so unique-constraint violations the
 * fixture is designed to expose (e.g. the duplicate rotation groups
 * #696 would have rejected) surface as errors rather than silent
 * dedupe.
 *
 * See tests/fixtures/shape.sql for the row content and
 * https://github.com/WXYC/Backend-Service/issues/701 for the rationale.
 */
async function loadShapeFixture() {
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10);
  const dbName = process.env.DB_NAME || 'wxyc_db';
  const dbUser = process.env.DB_USERNAME || 'test-user';
  const dbPass = process.env.DB_PASSWORD || 'test-pw';

  const fixturePath = path.join(__dirname, '..', 'fixtures', 'shape.sql');
  const rawSql = readFileSync(fixturePath, 'utf8');

  // Honor WXYC_SCHEMA_NAME for forward-compat with the parallel-worker
  // isolation roadmap. Today the migrations themselves hardcode
  // `wxyc_schema` so this rewrite is a no-op in CI; once the migrations
  // pick up the env var, the fixture will follow without code changes.
  const schemaName = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const fixtureSql = schemaName === 'wxyc_schema' ? rawSql : rawSql.replace(/\bwxyc_schema\b/g, schemaName);

  console.log('🧪 Loading shape fixture from', fixturePath, 'into schema', schemaName);

  const sql = postgres({
    host: dbHost,
    port: dbPort,
    database: dbName,
    user: dbUser,
    password: dbPass,
    max: 1,
    onnotice: () => {},
  });

  try {
    // Run the whole fixture in a single transaction so a partial failure
    // rolls back rather than leaving the schema half-populated.
    await sql.begin(async (tx) => {
      await tx.unsafe(fixtureSql);
    });
    console.log('✅ Shape fixture loaded.');
  } finally {
    await sql.end();
  }
}

module.exports = async () => {
  // Sensible defaults for ports/hosts used in CI
  const backendHost = process.env.BACKEND_HOST || 'localhost';
  const backendPort = process.env.PORT || process.env.BACKEND_PORT || process.env.CI_PORT || 8081;
  const backendHealthcheckUrl = `http://${backendHost}:${backendPort}/healthcheck`;

  // BETTER_AUTH_URL may be a full URL; if not present, fall back to AUTH_HOST/AUTH_PORT
  let authBaseUrl;
  if (process.env.BETTER_AUTH_URL) {
    try {
      authBaseUrl = new URL(process.env.BETTER_AUTH_URL).origin;
    } catch (err) {
      authBaseUrl = `http://${process.env.AUTH_HOST || 'localhost'}:${process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083}`;
    }
  } else {
    authBaseUrl = `http://${process.env.AUTH_HOST || 'localhost'}:${process.env.AUTH_PORT || process.env.CI_AUTH_PORT || 8083}`;
  }
  const authHealthcheckUrl = `${authBaseUrl}/healthcheck`;

  console.log('🚀 Global Setup: Waiting for services...');
  console.log('   Backend:', backendHealthcheckUrl);
  console.log('   Auth:', authHealthcheckUrl);

  const waitOnOptions = {
    resources: [backendHealthcheckUrl, authHealthcheckUrl],
    delay: 500,
    interval: 250,
    timeout: 60000,
    tcpTimeout: 1000,
    httpTimeout: 2000,
    log: false,
  };

  try {
    await waitOn(waitOnOptions);
    console.log('✅ Services are ready!');
  } catch (err) {
    console.error('❌ Error waiting for services:', err);
    throw err;
  }

  // Load the shape fixture into the per-worker schema. Runs after
  // services are confirmed ready (which means migrations and seed have
  // already been applied via dev_env/init-db.mjs at db:start time).
  // This injects the realistic edge-case rows (duplicate rotation
  // groups, NULL artist_name, mixed play_orders, etc.) that
  // constraint-adding migrations need to be tested against.
  try {
    await loadShapeFixture();
  } catch (err) {
    console.error('❌ Error loading shape fixture:', err);
    throw err;
  }
};

module.exports.loadShapeFixture = loadShapeFixture;
