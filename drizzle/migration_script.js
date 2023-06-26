import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
const sql = postgres({
  host: process.env.DB_ENDPOINT,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});
const db = drizzle(sql);
await migrate(db, { migrationsFolder: 'drizzle/migrations' });
