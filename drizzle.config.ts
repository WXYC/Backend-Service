import { defineConfig } from 'drizzle-kit';

const dbCredentials: Record<string, string | number> = {
  user: `${process.env.DB_USERNAME}`,
  host: `${process.env.DB_HOST}`,
  port: Number(process.env.DB_PORT),
  database: `${process.env.DB_NAME}`,
};

// Only include password if it's set (allows passwordless local connections)
if (process.env.DB_PASSWORD) {
  dbCredentials.password = process.env.DB_PASSWORD;
}

export default defineConfig({
  dialect: 'postgresql',
  schema: process.env.SCHEMA_LOC || 'shared/database/src/schema.ts',
  out: process.env.MIGRATION_LOC || 'shared/database/src/migrations',
  dbCredentials,
});
