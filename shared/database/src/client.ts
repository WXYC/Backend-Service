import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Validate required environment variables
const requiredEnvVars = ['DB_HOST', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('[ERROR] Missing required database environment variables:', missingVars.join(', '));
  throw new Error(`Missing required database environment variables: ${missingVars.join(', ')}`);
}

const queryClient = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

export const db = drizzle(queryClient, { schema });
