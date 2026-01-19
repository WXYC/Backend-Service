import { RequestHandler } from 'express';
import * as RequestLineService from '../services/requestLine.service.js';
import * as AnonymousDeviceService from '../services/anonymousDevice.service.js';

export type RequestLineBody = {
  message: string;
};

export type RegisterDeviceBody = {
  deviceId: string;
};

// Message validation constants
const MESSAGE_MIN_LENGTH = 1;
const MESSAGE_MAX_LENGTH = 500;

/**
 * Register an anonymous device and receive a JWT token.
 * POST /request/register
 */
export const registerDevice: RequestHandler<object, unknown, RegisterDeviceBody> = async (req, res, next) => {
  const requestId = `reg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();

  console.log(`[${requestId}] Device registration request:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString(),
  });

  const { deviceId } = req.body;

  // Validate deviceId
  if (!deviceId || typeof deviceId !== 'string') {
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Registration failed: missing deviceId`, { responseTime: `${responseTime}ms` });
    res.status(400).json({ message: 'deviceId is required' });
    return;
  }

  if (!AnonymousDeviceService.isValidDeviceId(deviceId)) {
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Registration failed: invalid deviceId format`, { responseTime: `${responseTime}ms` });
    res.status(400).json({ message: 'Invalid deviceId format. Must be a valid UUID.' });
    return;
  }

  try {
    // Register or retrieve device
    const result = await AnonymousDeviceService.registerDevice(deviceId);

    if (!result) {
      // Device is blocked
      const responseTime = Date.now() - startTime;
      console.log(`[${requestId}] Registration rejected: device blocked`, { deviceId, responseTime: `${responseTime}ms` });
      res.status(403).json({ message: 'Device has been blocked' });
      return;
    }

    // Generate token
    const tokenResult = await AnonymousDeviceService.generateToken(deviceId);

    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Registration successful:`, {
      deviceId,
      isNew: result.isNew,
      responseTime: `${responseTime}ms`,
    });

    res.status(200).json({
      token: tokenResult.token,
      expiresAt: tokenResult.expiresAt.toISOString(),
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const responseTime = Date.now() - startTime;
    console.error(`[${requestId}] Registration error:`, {
      error: error.message,
      stack: error.stack,
      responseTime: `${responseTime}ms`,
    });
    next(e);
  }
};

export const submitRequestLine: RequestHandler<object, unknown, RequestLineBody> = async (req, res, next) => {
  const logId = `rl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  const deviceId = req.anonymousDevice?.deviceId || 'unknown';

  // Log incoming request
  console.log(`[${logId}] Request line received:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    deviceId,
    userAgent: req.get('User-Agent'),
    messageLength: req.body.message?.length || 0,
    timestamp: new Date().toISOString(),
  });

  // Validate message is present (handle empty body case)
  if (!req.body || req.body.message === undefined) {
    const errorMsg = 'Bad Request: Missing request line message';
    console.log(`[${logId}] ${errorMsg}`);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Request completed:`, {
      statusCode: 400,
      responseTime: `${responseTime}ms`,
      error: errorMsg,
    });

    res.status(400).json({ message: errorMsg });
    return;
  }

  // Validate message length (after trim)
  const trimmedMessage = req.body.message.trim();
  if (trimmedMessage.length < MESSAGE_MIN_LENGTH) {
    const errorMsg = 'Bad Request: Message cannot be empty';
    console.log(`[${logId}] ${errorMsg}`);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Request completed:`, {
      statusCode: 400,
      responseTime: `${responseTime}ms`,
      error: errorMsg,
    });

    res.status(400).json({ message: errorMsg });
    return;
  }

  if (trimmedMessage.length > MESSAGE_MAX_LENGTH) {
    const errorMsg = `Bad Request: Message exceeds maximum length of ${MESSAGE_MAX_LENGTH} characters`;
    console.log(`[${logId}] ${errorMsg}`);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Request completed:`, {
      statusCode: 400,
      responseTime: `${responseTime}ms`,
      error: errorMsg,
    });

    res.status(400).json({ message: errorMsg });
    return;
  }

  try {
    const result = await RequestLineService.submitRequestLine(trimmedMessage);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Request completed successfully:`, {
      statusCode: 200,
      responseTime: `${responseTime}ms`,
      messageLength: trimmedMessage.length,
      deviceId,
      slackResponse: result,
    });

    res.status(200).json({
      success: true,
      message: 'Request line submitted successfully',
      result,
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const responseTime = Date.now() - startTime;

    console.error(`[${logId}] Request failed:`, {
      statusCode: 500,
      responseTime: `${responseTime}ms`,
      error: error.message,
      stack: error.stack,
      messageLength: req.body.message?.length || 0,
      deviceId,
    });

    next(e);
  }
};
