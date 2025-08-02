import { config } from 'dotenv';
config({ quiet: true });
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { parse as parse_yaml } from 'yaml';
import swaggerContent from './app.yaml';
import { dj_route } from './routes/djs.route.js';
import { flowsheet_route } from './routes/flowsheet.route.js';
import { library_route } from './routes/library.route.js';
import { schedule_route } from './routes/schedule.route.js';
import { jwtVerifier, cognitoMiddleware } from './middleware/cognito.auth.js';
import { showMemberMiddleware } from './middleware/checkShowMember.js';
import { activeShow } from './middleware/checkActiveShow.js';
// import errorHandler from './middleware/errorHandler';

const port = process.env.PORT || 8080;
const app = express();

//Interpret parse json into js objects
app.use(express.json());

//CORS
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

//Serve documentation
const swaggerDoc = parse_yaml(swaggerContent);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

app.use('/library', library_route);

app.use('/flowsheet', flowsheet_route);

app.use('/djs', dj_route);

app.use('/schedule', schedule_route);

//example for how to use te Cognito auth middleware
app.get('/testAuth', cognitoMiddleware(), async (req, res) => {
  res.json({ message: 'Authenticated!' });
});

//example of how cognito auth middleware can inform further middleware.
app.get('/testInShow', cognitoMiddleware(), activeShow, showMemberMiddleware, async (req, res) => {
  res.json({ message: 'Authenticated, active show, & show member' });
});

//On server startup we pre-fetch all jwt validation keys
jwtVerifier
  .hydrate()
  .catch((e) => {
    console.error(`Failed to hydrate JWT verifier : ${e}`);
  })
  .then(() => {
    const server = app.listen(port, () => {
      console.log(`listening on port: ${port}!`);
    });

    server.setTimeout(5000);
  });
