/**
 * CDC (Change Data Capture) listener for PostgreSQL LISTEN/NOTIFY.
 *
 * Creates a dedicated postgres-js connection for LISTEN (the query connection
 * cannot be reused for subscriptions). Parses CDC notification payloads and
 * dispatches them to registered callbacks.
 */

import postgres from 'postgres';

export interface CdcEvent {
  table: string;
  schema: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  data: Record<string, unknown> | null;
  timestamp: number;
}

export type CdcEventCallback = (event: CdcEvent) => void;

const CDC_CHANNEL = 'cdc';
let listenConnection: ReturnType<typeof postgres> | null = null;
let callbacks: CdcEventCallback[] = [];

/**
 * Registers a callback to receive CDC events.
 * Multiple callbacks can be registered; all are invoked for each event.
 */
export function onCdcEvent(callback: CdcEventCallback): void {
  callbacks.push(callback);
}

/**
 * Starts the CDC listener. Creates a dedicated LISTEN connection and
 * subscribes to the 'cdc' channel.
 */
export async function startCdcListener(): Promise<void> {
  if (listenConnection) {
    console.warn('[cdc-listener] Already started');
    return;
  }

  listenConnection = postgres({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });

  await listenConnection.listen(CDC_CHANNEL, (payload: string) => {
    try {
      const event = JSON.parse(payload) as CdcEvent;
      for (const cb of callbacks) {
        try {
          cb(event);
        } catch (err) {
          console.error('[cdc-listener] Callback error:', err);
        }
      }
    } catch (err) {
      console.error('[cdc-listener] Failed to parse CDC payload:', err);
    }
  });

  console.log('[cdc-listener] Listening on channel:', CDC_CHANNEL);
}

/**
 * Stops the CDC listener and closes the dedicated connection.
 */
export async function stopCdcListener(): Promise<void> {
  if (listenConnection) {
    await listenConnection.end();
    listenConnection = null;
    callbacks = [];
    console.log('[cdc-listener] Stopped');
  }
}
