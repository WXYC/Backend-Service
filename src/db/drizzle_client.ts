import 'dotenv/config';
import { PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const queryClient = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT != null ? +process.env.DB_PORT : 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

export const db: PostgresJsDatabase = drizzle(queryClient);
