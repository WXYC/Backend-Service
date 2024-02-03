import 'dotenv/config';
import express from 'express';
import { dj_route } from './routes/djs.route';
import { flowsheet_route } from './routes/flowsheet.route';
import { library_route } from './routes/library.route';
import { schedule_route } from './routes/schedule.route';
import { jwtVerifier, cognitoMiddleware } from './middleware/cognito.auth';
// import errorHandler from './middleware/errorHandler';

const port = process.env.PORT || 8080;
const app = express();

//Interpret parse json into js objects
app.use(express.json());

//CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH');
  next();
});

app.use('/library', library_route);

//route for compatibility with legacy api
app.use('/playlists', flowsheet_route);

app.use('/flowsheet', flowsheet_route);

app.use('/djs', dj_route);

app.use('/schedule', schedule_route);

//example for how to use te Cognito auth middleware
app.get('/testAuth', cognitoMiddleware('station-management'), async (req, res) => {
  res.json({ message: 'Authenticated!' });
});

// app.get(
//   '/testErrorHandler',
//   (req, res, next) => {
//     next(new Error('Testing Error'));
//   },
//   errorHandler
// );

//On server startup we pre-fetch all jwt validation keys
jwtVerifier
  .hydrate()
  .catch((e) => {
    console.error(`Failed to hydrate JWT verifier : ${e}`);
  })
  .then(() => {
    app.listen(port, () => {
      console.log(`listening on port: ${port}!`);
    });
  });
