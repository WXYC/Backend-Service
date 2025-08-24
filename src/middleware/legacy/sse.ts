import type { Response } from "express";

type EventPayload = Record<string, unknown> | string;

class SSEBroker {
  private clients = new Set<Response>();

  add(res: Response) {
    this.clients.add(res);
  }

  remove(res: Response) {
    this.clients.delete(res);
  }

  broadcast(event: string, data: EventPayload) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const frame = `event: ${event}\ndata: ${payload}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.remove(res);
      }
    }
  }

  size() {
    return this.clients.size;
  }
}

export const sseBroker = new SSEBroker();
