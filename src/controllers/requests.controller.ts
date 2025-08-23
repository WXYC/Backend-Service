import { RequestHandler } from 'express';
import * as RequestService from '../services/requests.service.js';
import { serverEventsMgr, Topics, ShowDjEvents, EventData } from '@/utils/serverEvents.js';

export type SongRequestBody = {
  message: string;
};

export const submitRequest: RequestHandler<object, unknown, SongRequestBody> = async (req, res, next) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const { message } = req.body;

  if (message === undefined) {
    res.status(400).json({ status: 400, message: 'Bad Request: Missing song request message' });
    return;
  }

  //Send to all subscribed showDJ clients
  const requestEvent: EventData = { type: ShowDjEvents.songRequest, payload: { request_message: message } };
  serverEventsMgr.broadcast(Topics.showDj, requestEvent);

  //Send to requests slack channel
  try {
    const result = await RequestService.slackSongRequest(message);

    res.status(200).json(result);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));

    console.error('Failed to send song request slack message');
    console.error(`[${requestId}] Request failed:`, {
      statusCode: 500,
      error: error.message,
      stack: error.stack,
    });

    next(e);
  }
};
