import { RequestHandler } from 'express';
import * as RequestLineService from '../services/requestLine.service.js';

export type RequestLineBody = {
  message: string;
};

export const submitRequestLine: RequestHandler<object, unknown, RequestLineBody> = async (req, res, next) => {
  const logId = `rl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();

  // Log incoming request
  console.log(`[${logId}] Request line received:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    messageLength: req.body.message?.length || 0,
    timestamp: new Date().toISOString(),
  });

  if (req.body.message === undefined) {
    const errorMsg = 'Bad Request: Missing request line message';
    console.log(`[${logId}] ${errorMsg}`);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Request completed:`, {
      statusCode: 400,
      responseTime: `${responseTime}ms`,
      error: errorMsg,
    });

    res.status(400).send(errorMsg);
    return;
  }

  try {
    const result = await RequestLineService.submitRequestLine(req.body.message);

    const responseTime = Date.now() - startTime;
    console.log(`[${logId}] Request completed successfully:`, {
      statusCode: 200,
      responseTime: `${responseTime}ms`,
      messageLength: req.body.message.length,
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
    });

    next(e);
  }
};
