import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { parse as parse_yaml } from 'yaml';
import swaggerContent from './app.yaml';
import { dj_route } from './routes/djs.route.js';
import { flowsheet_route } from './routes/flowsheet.route.js';

import { library_route } from './routes/library.route.js';
import { schedule_route } from './routes/schedule.route.js';
import { events_route } from './routes/events.route.js';
import { request_line_route } from './routes/requestLine.route.js';
import { showMemberMiddleware } from './middleware/checkShowMember.js';
import { activeShow } from './middleware/checkActiveShow.js';
import errorHandler from './middleware/errorHandler.js';
import { requirePermissions } from '@wxyc/authentication';

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

// Serve documentation
const swaggerDoc = parse_yaml(swaggerContent);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// Business logic routes
app.use('/library', library_route);

app.use('/flowsheet', flowsheet_route);

app.use('/djs', dj_route);

app.use('/request', request_line_route);

app.use('/schedule', schedule_route);

app.use(
  '/events',
  (req, res, next) => {
    // no global timeout on these long lived connections
    // SSE logic handles timeouts itself
    res.setTimeout(0);
    next();
  },
  events_route
);

//example for how to use te Cognito auth middleware
app.get('/testAuth', requirePermissions({ flowsheet: ['read'] }), async (req, res) => {
  res.json({ message: 'Authenticated!' });
});

//endpoint for healthchecks
app.get('/healthcheck', async (req, res) => {
  res.json({ message: 'Healthy!' });
});

app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`listening on port: ${port}!`);
});

server.setTimeout(5000);
