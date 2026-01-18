import { RequestHandler } from 'express';
import * as RequestService from '../services/request.service.js';

export type SongRequestBody = {
  message: string;
};

export const submitRequest: RequestHandler<object, unknown, SongRequestBody> = async (req, res, next) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  // Log incoming request
  console.log(`[${requestId}] Song request received:`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    messageLength: req.body.message?.length || 0,
    timestamp: new Date().toISOString()
  });

  if (req.body.message === undefined) {
    const errorMsg = 'Bad Request: Missing song request message';
    console.log(`[${requestId}] ${errorMsg}`);
    
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Request completed:`, {
      statusCode: 400,
      responseTime: `${responseTime}ms`,
      error: errorMsg
    });
    
    res.status(400).send(errorMsg);
    return;
  }

  try {
    const result = await RequestService.submitSongRequest(req.body.message);
    
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Request completed successfully:`, {
      statusCode: 200,
      responseTime: `${responseTime}ms`,
      messageLength: req.body.message.length,
      slackResponse: result
    });
    
    res.status(200).json({ 
      success: true, 
      message: 'Song request submitted successfully',
      result 
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const responseTime = Date.now() - startTime;
    
    console.error(`[${requestId}] Request failed:`, {
      statusCode: 500,
      responseTime: `${responseTime}ms`,
      error: error.message,
      stack: error.stack,
      messageLength: req.body.message?.length || 0
    });
    
    next(e);
  }
};
