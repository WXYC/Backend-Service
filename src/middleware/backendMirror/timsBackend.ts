import fetch,{ RequestInit } from "node-fetch";
import { Backend } from "./types.js";


export const requestFromOldBackend =
  (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string): Backend<any> =>
  async (payload, req) => {
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.header('Authorization') ?? '',
      },
    };
    if (method !== 'GET') init.body = JSON.stringify(payload);
    const r = await fetch(`${process.env.FLOWSHEET_BACKEND}${path}`, init);
    const data = await r.json().catch(() => undefined);
    return { status: r.status, data };
  };
