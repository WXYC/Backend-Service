//import 'dotenv/config';
//import { drizzle } from 'drizzle-orm/postgres-js';
//import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from '../../../dist/db/drizzle_client.js';

// const sql = postgres({
//   host: process.env.DB_ENDPOINT,
//   port: process.env.DB_PORT,
//   database: process.env.DB_NAME,
//   username: process.env.DB_USERNAME,
//   password: process.env.DB_PASSWORD,
// });
// const db = drizzle(sql);

migrate(db, { migrationsFolder: 'src/db/migrations' })
  .catch((e) => console.error(e))
  .then(() => console.log('MIGRATION COMPLETE!'));
