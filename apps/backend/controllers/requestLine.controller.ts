import { RequestHandler } from 'express';
import { processRequest, parseOnly, getConfig, isParsingEnabled } from '../services/requestLine/index.js';
import { postTextToSlack } from '../services/slack/index.js';
import { searchLibrary } from '../services/library.service.js';
import WxycError from '../utils/error.js';

export type RequestLineBody = {
  message: string;
  skipSlack?: boolean;
  skipParsing?: boolean;
};

export type RegisterDeviceBody = {
  deviceId: string;
};

export type LibrarySearchQuery = {
  artist?: string;
  title?: string;
  query?: string;
  limit?: string;
};

// Message validation constants
const MESSAGE_MIN_LENGTH = 1;
const MESSAGE_MAX_LENGTH = 500;

/**
 * Legacy device registration endpoint (deprecated).
 * Redirects clients to use the better-auth anonymous sign-in endpoint.
 * POST /request/register
 */
export const registerDevice: RequestHandler<object, unknown, RegisterDeviceBody> = async (req, res) => {
  const authUrl = process.env.BETTER_AUTH_URL || 'http://localhost:8082/auth';

  console.log('Legacy /request/register endpoint called - redirecting to better-auth', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString(),
  });

  res.status(410).json({
    message: 'This endpoint is deprecated. Use POST /auth/sign-in/anonymous for registration.',
    endpoint: `${authUrl}/sign-in/anonymous`,
  });
};

export const submitRequestLine: RequestHandler<object, unknown, RequestLineBody> = async (req, res, next) => {
  const logId = `rl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  const userId = req.auth?.id || 'unknown';

  // Log incoming request
  console.log(`[${logId}] Request line received:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userId,
    userAgent: req.get('User-Agent'),
    messageLength: req.body.message?.length || 0,
    timestamp: new Date().toISOString(),
  });

  // Validate message
  if (!req.body || req.body.message === undefined) throw new WxycError('Missing request line message', 400);
  const trimmedMessage = req.body.message.trim();
  if (trimmedMessage.length < MESSAGE_MIN_LENGTH) throw new WxycError('Message cannot be empty', 400);
  if (trimmedMessage.length > MESSAGE_MAX_LENGTH) {
    throw new WxycError(`Message exceeds maximum length of ${MESSAGE_MAX_LENGTH} characters`, 400);
  }

  try {
    // Use enhanced service if AI parsing is available, otherwise fall back to simple Slack post
    const config = getConfig();

    if (isParsingEnabled(config)) {
      // Use enhanced pipeline with AI parsing, library search, and artwork
      const result = await processRequest({
        message: trimmedMessage,
        skipSlack: req.body.skipSlack,
        skipParsing: req.body.skipParsing,
      });

      const responseTime = Date.now() - startTime;
      console.log(`[${logId}] Request completed successfully (enhanced):`, {
        statusCode: 200,
        responseTime: `${responseTime}ms`,
        messageLength: trimmedMessage.length,
        userId,
        searchType: result.searchType,
        libraryResultsCount: result.libraryResults.length,
        hasArtwork: !!result.artwork?.artworkUrl,
        parsed: {
          isRequest: result.parsed.isRequest,
          messageType: result.parsed.messageType,
          hasArtist: !!result.parsed.artist,
          hasAlbum: !!result.parsed.album,
          hasSong: !!result.parsed.song,
        },
      });

      res.status(200).json(result);
    } else {
      // Fall back to simple Slack post (legacy behavior)
      const result = await postTextToSlack(trimmedMessage);

      const responseTime = Date.now() - startTime;
      console.log(`[${logId}] Request completed successfully (legacy):`, {
        statusCode: 200,
        responseTime: `${responseTime}ms`,
        messageLength: trimmedMessage.length,
        userId,
        slackResponse: result,
      });

      res.status(200).json({
        success: true,
        message: 'Request line submitted successfully',
        result,
      });
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const responseTime = Date.now() - startTime;

    console.error(`[${logId}] Request failed:`, {
      statusCode: 500,
      responseTime: `${responseTime}ms`,
      error: error.message,
      stack: error.stack,
      messageLength: req.body.message?.length || 0,
      userId,
    });

    next(e);
  }
};

/**
 * Parse a message only (for debugging).
 * POST /request/parse
 */
export const parseMessage: RequestHandler<object, unknown, { message: string }> = async (req, res, next) => {
  const logId = `parse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();

  console.log(`[${logId}] Parse request received:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    messageLength: req.body.message?.length || 0,
    timestamp: new Date().toISOString(),
  });

  const message = req.body.message?.trim();
  if (!message) {
    res.status(400).json({ message: 'Message is required' });
    return;
  }

  try {
    const parsed = await parseOnly(message);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Parse completed:`, {
      responseTime: `${responseTime}ms`,
      parsed: {
        isRequest: parsed.isRequest,
        messageType: parsed.messageType,
        hasArtist: !!parsed.artist,
        hasAlbum: !!parsed.album,
        hasSong: !!parsed.song,
      },
    });

    res.status(200).json({ success: true, parsed });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const responseTime = Date.now() - startTime;

    console.error(`[${logId}] Parse failed:`, {
      responseTime: `${responseTime}ms`,
      error: error.message,
    });

    next(e);
  }
};

/**
 * GET /library/search — public catalog search backing the request line.
 *
 * Canonical caller: the request-line flow (`POST /request`), where a
 * listener names a song and the DJ (or an automated matcher) looks up the
 * closest catalog hit to attach to the request before submitting it. Lives
 * in `requestLine.controller.ts` but is mounted under `/library` in
 * `library.route.ts` — see that file's header comment for how this sits
 * alongside `GET /library/` and `GET /library/query`. Not to be confused
 * with `GET /proxy/library/search` (`proxy.controller.ts`), which proxies
 * straight through to LML's own `/library/search` for dj-site's flowsheet
 * autocomplete; this endpoint reads BS's own catalog via `searchLibrary` in
 * `library.service.ts`.
 *
 * Auth: `requirePermissions({})` — any authenticated JWT, including an
 * anonymous better-auth session. No `catalog:read`/`catalog:write` role is
 * required, which makes this the only one of the three library-search
 * variants a bare listener session can call.
 *
 * Query semantics: at least one of `artist`, `title`, or `query` is
 * required (400 otherwise). A free-text `query` routes through
 * `searchLibrary`'s tsvector + trigram + CTA/LML cascade
 * (`searchLibraryBothMode`); `artist` and/or `title` alone route through the
 * trigram-only `fuzzySearchLibrary` path. See `searchLibrary` in
 * `library.service.ts` for the full cascade and the
 * `CATALOG_TRACK_SEARCH_CTA_ENABLED` / `CATALOG_TRACK_SEARCH_DISCOGS_ENABLED`
 * / `CATALOG_SEARCH_ALIAS_ENABLED` flags that gate its fallback stages.
 *
 * Response shape: `{ success: true, results: EnrichedLibraryResult[], total,
 * query: { artist, title, query, limit } }` — the only one of the three
 * that wraps its rows in a `{ success, ... }` envelope, rather than
 * returning a bare array (`GET /library/`) or an offset-paginated
 * `{ results, total, page, totalPages }` object (`GET /library/query`).
 */
export const searchLibraryEndpoint: RequestHandler<object, unknown, unknown, LibrarySearchQuery> = async (
  req,
  res,
  next
) => {
  const logId = `search-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();

  const { artist, title, query, limit } = req.query;
  const limitNum = limit ? parseInt(limit, 10) : 5;

  console.log(`[${logId}] Library search request:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    artist,
    title,
    query,
    limit: limitNum,
    timestamp: new Date().toISOString(),
  });

  if (!artist && !title && !query) {
    res.status(400).json({ message: 'At least one of artist, title, or query is required' });
    return;
  }

  try {
    const results = await searchLibrary(query, artist, title, limitNum);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Search completed:`, {
      responseTime: `${responseTime}ms`,
      resultsCount: results.length,
    });

    res.status(200).json({
      success: true,
      results,
      total: results.length,
      query: { artist, title, query, limit: limitNum },
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const responseTime = Date.now() - startTime;

    console.error(`[${logId}] Search failed:`, {
      responseTime: `${responseTime}ms`,
      error: error.message,
    });

    next(e);
  }
};
