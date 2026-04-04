/**
 * Mock API server for WXYC Backend-Service CI integration tests.
 *
 * Simulates three external services:
 * - LML (library-metadata-lookup): /api/v1/discogs/*
 * - Slack: /services/*
 * - Tubafrenzy: /playlists/api/flowsheetEntry
 *
 * Plus a control API at /_admin/* for test orchestration.
 */

import express from 'express';
import lmlRoutes from './routes/lml.js';
import slackRoutes from './routes/slack.js';
import tubafrenzyRoutes from './routes/tubafrenzy.js';
import adminRoutes from './control/admin.js';

const app = express();
const PORT = parseInt(process.env.MOCK_API_PORT || '9090', 10);

app.use(express.json());

// Service routes
app.use(lmlRoutes);
app.use(slackRoutes);
app.use(tubafrenzyRoutes);

// Admin control
app.use('/_admin', adminRoutes);

app.listen(PORT, () => {
  console.log(`🎭 Mock API server listening on port ${PORT}`);
  console.log(`   LML:        /api/v1/discogs/*`);
  console.log(`   Slack:      /services/*`);
  console.log(`   Tubafrenzy: /playlists/api/flowsheetEntry`);
  console.log(`   Admin:      /_admin/*`);
});
