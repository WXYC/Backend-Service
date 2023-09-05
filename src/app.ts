//import fetch, { Response as Fetch_Response } from 'node-fetch';
import 'dotenv/config';
import express from 'express';
import { dj_route } from './routes/djs.route';
import { flowsheet_route } from './routes/flowsheet.route';
import { library_route } from './routes/library.route';
import { schedule_route } from './routes/schedule.route';

const port = process.env.PORT || 8080;
const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH');
  next();
});

/* TODO
-Accept jwt and verify that user is part of mgmt.
-Use cognito api to update user store as well.
*/

app.use('/playlists', library_route);

app.use('/flowsheet', flowsheet_route);

app.use('/djs', dj_route);

app.use('/library', library_route);

app.use('/schedule', schedule_route);

app.listen(port, () => {
  console.log(`listening on port: ${port}!`);
});
