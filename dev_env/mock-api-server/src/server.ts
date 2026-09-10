/**
 * Mock API server for WXYC Backend-Service CI integration tests.
 *
 * Simulates two external services:
 * - LML (library-metadata-lookup): /api/v1/discogs/*
 * - Slack: /services/*
 *
 * A tubafrenzy mirror mock lived here until BS#2403 retired the mirror.
 *
 * Plus a control API at /_admin/* for test orchestration.
 */

import express from 'express';
import lmlRoutes from './routes/lml.js';
import slackRoutes from './routes/slack.js';
import adminRoutes from './control/admin.js';

const app = express();
const PORT = parseInt(process.env.MOCK_API_PORT || '9090', 10);

app.use(express.json());

// Service routes
app.use(lmlRoutes);
app.use(slackRoutes);

// Admin control
app.use('/_admin', adminRoutes);

app.listen(PORT, () => {
  console.log(`🎭 Mock API server listening on port ${PORT}`);
  console.log(`   LML:        /api/v1/discogs/*`);
  console.log(`   Slack:      /services/*`);
  console.log(`   Admin:      /_admin/*`);
});
