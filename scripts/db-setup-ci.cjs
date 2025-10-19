#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

console.log('Setting up CI database...');

// Set environment variables
process.env.PGPASSWORD = 'RadioIsEpic$1100';
process.env.DB_PORT = '5433';
process.env.DB_HOST = 'localhost';

try {
  // Install extensions
  console.log('Installing PostgreSQL extensions...');
  execSync('psql -h localhost -p 5433 -U wxyc_admin -d wxyc_db -f dev_env/install_extensions.sql', {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: 'RadioIsEpic$1100' }
  });

  // Run migrations
  console.log('Running database migrations...');
  execSync('npm run drizzle:migrate', { stdio: 'inherit' });

  // Seed database
  console.log('Seeding database...');
  execSync('psql -h localhost -p 5433 -U wxyc_admin -d wxyc_db -f dev_env/seed_db.sql', {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: 'RadioIsEpic$1100' }
  });

  console.log('✅ DB setup complete!');
} catch (error) {
  console.error('❌ DB setup failed:', error.message);
  process.exit(1);
}
