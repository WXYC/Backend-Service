//import fetch, { Response as Fetch_Response } from 'node-fetch';
import 'dotenv/config';
import express, { Request, Response } from 'express';
import * as schema from './db/schema.js';
//import { sql } from 'drizzle-orm';
import { db } from './db/drizzle_client.js';
import { router as dj_route } from './routes/djs.js';

const port = process.env.PORT;
const app = express();
app.use(express.json());

type queryParams = {
  page: number;
  limit: number;
  start_date: string;
  end_date: string;
};

app.get('/', (req: Request, res: Response) => {
  const query = req.query as unknown as queryParams;
  let outstring = '';
  if (query.page && query.limit) {
    const offset = query.page * query.limit;
    const limit = req.query.limit;
    outstring += 'pageinate ';

    if (query.start_date && query.end_date) {
      const startDate = query.start_date;
      const endDate = query.end_date;
      outstring += 'dates';
    }
  } else {
    outstring = 'Need page and limit vals';
  }
  res.send(outstring);
});

app.get('/:dj_name', (req: Request, res: Response) => {
  console.log(req.params.dj_name);
  res.send(`<button>${req.params.dj_name}</button>`);
});

app.post('/');

/* TODO
-Accept jwt and verify that user is part of mgmt.
-Use cognito api to update user store as well.
*/
app.use('/djs', dj_route);

app.post('/remove_dj', (req: Request, res: Response) => {
  console.log('hello');
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`listening on port: ${port}!`);
});
