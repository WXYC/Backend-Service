//import fetch, { Response as Fetch_Response } from 'node-fetch';
import 'dotenv/config';
import express from 'express';
import { dj_route } from './routes/djs.route';
import { flowsheet_route } from './routes/flowsheet.route';
import { library_route } from './routes/library.route';

const port = process.env.PORT;
const app = express();
app.use(express.json());

/* TODO
-Accept jwt and verify that user is part of mgmt.
-Use cognito api to update user store as well.
*/

app.use('/flowsheet', flowsheet_route);

app.use('/djs', dj_route);

app.use('/library', library_route);

app.listen(port, () => {
  console.log(`listening on port: ${port}!`);
});
