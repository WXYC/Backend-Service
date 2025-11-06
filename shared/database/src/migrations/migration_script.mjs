import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const migrationClient = postgres(
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  },
  { max: 1 }
);

const db = drizzle(migrationClient);

migrate(db, { migrationsFolder: 'src/db/migrations' })
  .catch((e) => console.error(e))
  .then(() => console.log('MIGRATION COMPLETE!'));
