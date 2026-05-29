import * as Sentry from '@sentry/node';
import WxycError from '../utils/error.js';
import { Response } from 'express';
import { recordBroadcast, recordBroadcastFailure } from '../services/sse/sse-metrics.js';

export const Topics = {
  test: 'test-topic', // just for POC testing.
  primaryDj: 'prim-dj-topic', // events for the primary dj e.g. remote dj show takover request.
  showDj: 'show-dj-topic', // events for all show djs e.g. song requests from app or guest dj requesting to add to bin.
  liveFs: 'live-fs-topic', // events related to fs entries e.g. crud events. Can be used to keep UIs synced live.
  mirror: 'mirror-topic', // events for the mirror service with Tim's old backend.
} as const;

export const TestEvents = {
  test: 'test',
} as const;

export const ShowDjEvents = {
  addToBin: 'bin-add',
  songRequest: 'track-request',
} as const;

export const PrimaryDjEvents = {
  showTakeover: 'show-takeover',
} as const;

export const FsEvents = {
  add: 'add',
  delete: 'delete',
  update: 'update',
  refetch: 'refetch',
} as const;

export const MirrorEvents = {
  syncStarted: 'sync-started',
  syncProgress: 'sync-progress',
  syncComplete: 'sync-complete',
  syncRetry: 'sync-retry',
  syncError: 'sync-error',
};

export type EventClient = {
  id: string; //uuid
  res: Response;
};

export type EventData<T = unknown> = {
  type: string;
  payload: T;
  timestamp?: Date;
};

export class ServerEventsManager {
  constructor(...topicNames: string[]) {
    this.topics = new Set(topicNames);
  }

  // 30 s matches tubafrenzy's upstream SSE feed (see `playlist-proxy.service.ts`
  // prose) and stays under nginx/ALB's 60 s idle defaults.
  private static readonly HEARTBEAT_INTERVAL_MS = 30 * 1000;
  private static readonly HEARTBEAT_FRAME = ': keepalive\n\n';

  private topics: Set<string> = new Set();
  // each map key is a topic e.g. primary_dj, show_dj, live_fs,
  private clients: Map<string, EventClient> = new Map();
  private clientTopics: Map<string, Set<string>> = new Map(); // clientId -> topicIds
  private topicClients: Map<string, Set<string>> = new Map(); // topicId -> clientIds
  private clientHeartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();

  /**
   * Writes a `: keepalive\n\n` SSE comment to the client every
   * HEARTBEAT_INTERVAL_MS. The comment frame is silent to `addEventListener`
   * consumers (per the SSE spec) but keeps the TCP connection alive and resets
   * any intermediary idle timers. On write failure (half-dead socket: EPIPE,
   * write-after-end) we capture to Sentry under `op: 'heartbeat'` and
   * `unsubAll` to drop the client from the maps.
   */
  private startHeartbeat = (clientId: string) => {
    const existing = this.clientHeartbeats.get(clientId);
    if (existing) clearInterval(existing);

    const intervalId = setInterval(() => {
      const client = this.clients.get(clientId);
      if (!client) {
        clearInterval(intervalId);
        this.clientHeartbeats.delete(clientId);
        return;
      }
      try {
        client.res.write(ServerEventsManager.HEARTBEAT_FRAME);
      } catch (error) {
        Sentry.captureException(error, {
          tags: { subsystem: 'sse', op: 'heartbeat' },
          extra: { client_id: clientId },
        });
        this.unsubAll(clientId);
      }
    }, ServerEventsManager.HEARTBEAT_INTERVAL_MS);

    // unref so SIGTERM isn't blocked by an idle heartbeat ticker.
    intervalId.unref?.();

    this.clientHeartbeats.set(clientId, intervalId);
  };

  private stopHeartbeat = (clientId: string) => {
    const intervalId = this.clientHeartbeats.get(clientId);
    if (intervalId) {
      clearInterval(intervalId);
      this.clientHeartbeats.delete(clientId);
    }
  };

  registerClient = (res: Response): EventClient => {
    const client: EventClient = {
      id: crypto.randomUUID(),
      res: res,
    };

    this.startHeartbeat(client.id);

    client.res.on('close', () => {
      this.stopHeartbeat(client.id);
      this.unsubAll(client.id);
    });

    // Send SSE headers
    client.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Accel-Buffering': 'no', // Header that makes nginx behave with sse
    });

    // Send initial connection event with client ID
    const connectionEvent = {
      type: 'connection-established',
      payload: { clientId: client.id },
      timestamp: new Date(),
    };
    client.res.write(`data: ${JSON.stringify(connectionEvent)}\n\n`);

    this.clients.set(client.id, client);

    return client;
  };

  subscribe = (topicIds: string[], clientId: string): string[] => {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new WxycError(`Client connection not found: ${clientId}`, 404);
    }

    // Filter out topics that aren't registered with ServerEventsManager instance
    topicIds = topicIds.filter((topic) => this.topics.has(topic));

    // Track client's topics
    if (!this.clientTopics.has(clientId)) {
      this.clientTopics.set(clientId, new Set());
    }

    // Track new topic subscriptions
    const newSubs: string[] = [];
    topicIds.forEach((topicId) => {
      if (!this.clientTopics.get(clientId)!.has(topicId)) {
        newSubs.push(topicId);
      }
      this.clientTopics.get(clientId)!.add(topicId);
    });

    // Track topic's clients
    topicIds.forEach((topicId) => {
      if (!this.topicClients.has(topicId)) {
        this.topicClients.set(topicId, new Set());
      }
      this.topicClients.get(topicId)!.add(clientId);
    });

    // Send Subscription Event
    const connectionEvent = {
      type: 'subscription',
      payload: {
        client_id: clientId,
        topics: newSubs,
      },
      timestamp: new Date(),
    };

    client.res.write(`data: ${JSON.stringify(connectionEvent)}\n\n`);

    return newSubs;
  };

  unsubscribe = (topicId: string, clientId: string) => {
    // Remove from client's topics
    this.clientTopics.get(clientId)?.delete(topicId);

    // Remove from topic's clients
    this.topicClients.get(topicId)?.delete(clientId);

    // cleanup
    if (this.topicClients.get(topicId)?.size == 0) {
      this.topicClients.delete(topicId);
    }

    if (this.clientTopics.get(clientId)?.size == 0) {
      this.clientTopics.delete(clientId);
    }
  };

  unsubAll = (clientId: string) => {
    // Get all topics this client was subscribed to
    const clientTopics = this.clientTopics.get(clientId) || new Set();

    // Remove client from all topic sets and clean up empty topics
    clientTopics.forEach((topicId) => {
      const topicClientSet = this.topicClients.get(topicId);
      if (topicClientSet) {
        topicClientSet.delete(clientId);
        if (topicClientSet.size === 0) {
          this.topicClients.delete(topicId);
        }
      }
    });

    this.clientTopics.delete(clientId);
    this.clients.delete(clientId);

    this.stopHeartbeat(clientId);
  };

  broadcast = (topicId: string, data: EventData) => {
    const clientIds = this.topicClients.get(topicId) || new Set();

    if (!data.timestamp) {
      data.timestamp = new Date();
    }

    const message = `data: ${JSON.stringify(data)}\n\n`;

    // One EventsBroadcast count per logical broadcast (not per fan-out write),
    // so zero-subscriber topics still register as activity.
    recordBroadcast(topicId);

    clientIds.forEach((clientId) => {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.res.write(message);
        } catch (error) {
          // The CloudWatch counter (BS-3) makes the rate visible; Sentry
          // surfaces the exception so we can read the underlying error
          // (write-after-end, EPIPE, etc.) when the rate spikes.
          recordBroadcastFailure(topicId);
          Sentry.captureException(error, {
            tags: { subsystem: 'sse', op: 'broadcast', topic: topicId },
            extra: { client_id: client.id },
          });
          this.unsubAll(client.id);
        }
      }
    });
  };

  dispatch = (topicId: string, clientId: string, data: EventData) => {
    if (!this.topicClients.get(topicId)?.has(clientId)) {
      throw new WxycError(`Client not found subscribed to ${topicId}: ${clientId}`, 404);
    }

    const client = this.clients.get(clientId);

    if (!data.timestamp) {
      data.timestamp = new Date();
    }

    const message = `data: ${JSON.stringify(data)}\n\n`;

    if (client) {
      try {
        client.res.write(message);
      } catch (error) {
        recordBroadcastFailure(topicId);
        Sentry.captureException(error, {
          tags: { subsystem: 'sse', op: 'dispatch', topic: topicId },
          extra: { client_id: client.id },
        });
        this.unsubAll(client.id);
      }
    }
  };

  disconnect = (clientId: string, reason?: string) => {
    const client = this.clients.get(clientId);
    if (client) {
      // Send a final event if reason is provided
      if (reason) {
        try {
          const disconnectEvent = {
            type: 'connection-closed',
            payload: { message: reason },
            timestamp: new Date(),
          };
          client.res.write(`data: ${JSON.stringify(disconnectEvent)}\n\n`);
        } catch (error) {
          // Client might already be disconnected
        }
      }

      try {
        client.res.end();
      } catch (error) {
        // Connection might already be closed
      }
    }
    this.unsubAll(clientId);
  };

  getSubs = (clientId: string) => {
    return [...(this.clientTopics.get(clientId) || [])];
  };

  /**
   * Snapshot of subscribed-client count keyed by topic. Used by the CloudWatch
   * `SSE/ClientCount` gauge in `apps/backend/services/sse/sse-metrics.ts`.
   *
   * Reports only topics with at least one client — the metrics layer adds the
   * dimensionless companion (`Dimensions: []`) for the alarm input, so the
   * absence of a per-topic point is the right shape here. Topics that have
   * never had a subscriber don't show up.
   */
  getClientCountByTopic = (): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [topic, clients] of this.topicClients) {
      if (clients.size > 0) out.set(topic, clients.size);
    }
    return out;
  };
}

export const serverEventsMgr = new ServerEventsManager(...Object.values(Topics));
