// server.ts (Hono – Node or Workers)
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth.js";

const app = new Hono();

if (!process.env.FRONTEND_SOURCE) {
  throw new Error("Missing FRONTEND_SOURCE env var");
}

app.use("/api/auth/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  credentials: true, // must be true when using cookies cross-origin
}));

// Add CORS for session endpoint
app.use("/api/auth/session", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  credentials: true,
}));

// (Optional) a helper endpoint to read session server-side from Next
app.get("/api/auth/session", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return c.json({ session });
});

// Also support POST for session endpoint
app.post("/api/auth/token", async (c) => {
  const session = await auth.api.getToken({ headers: c.req.raw.headers });
  return c.json({ session });
});

// Mount the Better Auth handler on both GET and POST for all other auth routes:
app.on(["GET","POST"], "/api/auth/*", async (c) => {
  const response = await auth.handler(c.req.raw);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

const port = process.env.PORT || "8082";

// Start the server
import { serve } from '@hono/node-server';

serve({
  fetch: app.fetch,
  port: parseInt(port),
}, () => {
  console.log(`Auth service listening on port: ${port}!`);
});

export default app;
