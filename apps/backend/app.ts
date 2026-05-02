import './instrument.js';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { parse as parse_yaml } from 'yaml';
import swaggerContent from './app.yaml';
import { dj_route } from './routes/djs.route.js';
import { flowsheet_route } from './routes/flowsheet.route.js';
import { labels_route } from './routes/labels.route.js';

import { library_route } from './routes/library.route.js';
import { schedule_route } from './routes/schedule.route.js';
import { events_route } from './routes/events.route.js';
import { request_line_route } from './routes/requestLine.route.js';
import { config_route } from './routes/config.route.js';
import { internal_route } from './routes/internal.route.js';
import { proxy_route } from './routes/proxy.route.js';
import { playlist_route } from './routes/playlist.route.js';
import { startPlaylistProxy, stopPlaylistProxy } from './services/playlist-proxy.service.js';
import { startAlbumPlaysRefresh, stopAlbumPlaysRefresh } from './services/album-plays-refresh.service.js';
import { setupCdcWebSocket, shutdownCdcWebSocket } from './services/cdc/index.js';
import { activeShow } from './middleware/checkActiveShow.js';
import errorHandler from './middleware/errorHandler.js';
import { shouldCaptureExpressError } from './middleware/sentryErrorFilter.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { responseMetricsMiddleware } from './middleware/responseMetrics.js';
import { requirePermissions } from '@wxyc/authentication';
import { closeDatabaseConnection, db } from '@wxyc/database';
import { sql } from 'drizzle-orm';

const port = process.env.PORT || 8080;
const app = express();

app.set('trust proxy', true);

//Interpret parse json into js objects
app.use(express.json());

// Cross-service request correlation
app.use(requestIdMiddleware);

// CloudWatch metric for flowsheet mutation 4xx (replacement signal post-#691).
// Mounted before routes so its `res.on('finish')` listener attaches for every
// request — route handlers normally end the response with `res.json(...)`
// without calling `next()`, so a late mount never observes their status. The
// filter inside the listener keeps emission scoped to mutation routes only.
app.use(responseMetricsMiddleware);

//CORS
app.use(
  cors({
    origin: process.env.FRONTEND_SOURCE || '*',
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Internal-Key'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
  })
);

// Serve documentation
const swaggerDoc = parse_yaml(swaggerContent);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// Public configuration endpoint (unauthenticated)
app.use('/config', config_route);

// Proxy endpoints for iOS app (anonymous auth + rate limiting)
app.use('/proxy', proxy_route);

// Enriched playlist proxy (unauthenticated, matches tubafrenzy path)
app.use('/playlists', playlist_route);

// Business logic routes
app.use('/labels', labels_route);

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
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ message: 'Healthy!' });
  } catch {
    res.status(503).json({ message: 'Database unreachable' });
  }
});

// Internal endpoints (ETL sync notifications, key-authenticated)
app.use('/internal', internal_route);

Sentry.setupExpressErrorHandler(app, { shouldHandleError: shouldCaptureExpressError });
app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`listening on port: ${port}!`);
  startPlaylistProxy();
  startAlbumPlaysRefresh();
  void setupCdcWebSocket(server);
});

server.setTimeout(30000);

// --- Memory monitoring ---

const MEMORY_LOG_INTERVAL = 5 * 60 * 1000; // 5 minutes
const memoryLogTimer = setInterval(() => {
  const usage = process.memoryUsage();
  console.log(
    `[memory] rss=${(usage.rss / 1024 / 1024).toFixed(1)}MB heap=${(usage.heapUsed / 1024 / 1024).toFixed(1)}/${(usage.heapTotal / 1024 / 1024).toFixed(1)}MB`
  );
}, MEMORY_LOG_INTERVAL);
memoryLogTimer.unref();

// --- Graceful shutdown ---

function shutdown(signal: string): void {
  console.log(`[shutdown] Received ${signal}, shutting down...`);
  stopPlaylistProxy();
  stopAlbumPlaysRefresh();
  void shutdownCdcWebSocket();
  server.close(() => {
    closeDatabaseConnection()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => {
    console.warn('[shutdown] Force closing remaining connections');
    server.closeAllConnections();
  }, 5_000).unref();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
