import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const queryClient = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
});

export const db = drizzle(queryClient, { schema });
