import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: process.env.SCHEMA_LOC || 'shared/database/src',
  out: process.env.MIGRATION_LOC || 'shared/database/src/migrations',
  dbCredentials: {
    user: `${process.env.DB_USERNAME}`,
    password: `${process.env.DB_PASSWORD}`,
    host: `${process.env.DB_HOST}`,
    port: Number(process.env.DB_PORT),
    database: `${process.env.DB_NAME}`,
  },
});
