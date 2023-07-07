//import fetch, { Response as Fetch_Response } from 'node-fetch';
import 'dotenv/config';
import express, { Request, Response } from 'express';
import * as schema from './db/schema.js';
//import { sql } from 'drizzle-orm';
import { db } from './db/drizzle_client.js';
import { dj_route } from './routes/djs.route.js';
import { flowsheet_route } from './routes/flowsheet.route.js';

const port = process.env.PORT;
const app = express();
app.use(express.json());

type QueryParams = {
  page: number;
  limit: number;
  start_date: string;
  end_date: string;
};

app.use('/flowsheet', flowsheet_route);

/* TODO
-Accept jwt and verify that user is part of mgmt.
-Use cognito api to update user store as well.
*/
app.use('/djs', dj_route);

app.listen(port, () => {
  console.log(`listening on port: ${port}!`);
});
