import WxycError from '@/utils/error.js';
import { Response } from 'express';

export const Topics = {
  test: 'test-topic', // just for POC testing.
  primaryDj: 'prim-dj-topic', // events for the primary dj e.g. remote dj show takover request.
  showDj: 'show-dj-topic', // events for all show djs e.g. song requests from app or guest dj requesting to add to bin.
  liveFs: 'live-fs-topic', // events related to fs entries e.g. crud events. Can be used to keep UIs synced live.
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

export type EventClient = {
  id: string; //uuid
  res: Response;
};

export type EventData<T = unknown> = {
  type: string;
  payload: T;
  timestamp?: Date;
};

class ServerEventsManager {
  constructor(...topicNames: string[]) {
    this.topics = new Set(topicNames);
  }

  private topics: Set<string> = new Set();
  // each map key is a topic e.g. primary_dj, show_dj, live_fs,
  private clients: Map<string, EventClient> = new Map();
  private clientTopics: Map<string, Set<string>> = new Map(); // clientId -> topicIds
  private topicClients: Map<string, Set<string>> = new Map(); // topicId -> clientIds

  registerClient = (res: Response): EventClient => {
    const client: EventClient = {
      id: crypto.randomUUID(),
      res: res,
    };

    // Add timeout for stale connections
    const timeout = setTimeout(
      () => {
        if (this.clients.has(client.id)) {
          this.disconnect(client.id, 'Connection terminated due to inactivity');
        }
      },
      5 * 60 * 1000 // 5 minutes
    );

    client.res.on('close', () => {
      clearTimeout(timeout);
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
  };

  broadcast = (topicId: string, data: EventData) => {
    const clientIds = this.topicClients.get(topicId) || new Set();

    if (!data.timestamp) {
      data.timestamp = new Date();
    }

    const message = `data: ${JSON.stringify(data)}\n\n`;

    clientIds.forEach((clientId) => {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.res.write(message);
        } catch (error) {
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
}

export const serverEventsMgr = new ServerEventsManager(...Object.values(Topics));
