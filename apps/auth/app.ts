// Auth service using Express
import { db, organization } from "@wxyc/database";
import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express from "express";
import { auth } from "./auth.js";
import { eq } from "drizzle-orm";

const app = express();

// Apply CORS globally to all routes
app.use(
  cors({
    origin: process.env.FRONTEND_SOURCE || "*",
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie", "Set-Cookie"],
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
    exposedHeaders: ["Content-Length", "Set-Cookie"],
  })
);

// Parse JSON bodies
app.use(express.json());

// (Optional) a helper endpoint to read session server-side
app.get("/api/auth/session", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: new Headers(req.headers as HeadersInit),
    });
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: "Failed to get session" });
  }
});

// Also support POST for token endpoint
app.post("/api/auth/token", async (req, res) => {
  try {
    const session = await auth.api.getToken({
      headers: new Headers(req.headers as HeadersInit),
    });
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: "Failed to get token" });
  }
});

// Mount the Better Auth handler for all auth routes
// Use app.use() to handle all methods and paths under /api/auth
app.use("/api/auth", toNodeHandler(auth));

const port = process.env.AUTH_PORT || "8082";

// Create default user if needed
const createDefaultUser = async () => {
  if (process.env.CREATE_DEFAULT_USER !== "TRUE") return;

  try {
    const username = process.env.DEFAULT_USER_USERNAME!;
    const email = process.env.DEFAULT_USER_EMAIL!;

    let userId: string;

    // Try to create user, get existing user if already exists
    const { available } = await auth.api.isUsernameAvailable({
      body: { username },
    });

    if (available) {
      const { user } = await auth.api.createUser({
        body: {
          email: email,
          password: process.env.DEFAULT_USER_PASSWORD!,
          name: process.env.DEFAULT_USER_NAME || "Admin User",
          role: "admin",
          data: {
            username: username,
            realName: process.env.DEFAULT_USER_NAME || "Admin User",
            djName: process.env.DEFAULT_USER_DJ_NAME || "Admin DJ",
            appSkin: "modern-light",
          },
        },
      });
      userId = user?.id!;
    } else {
      // User exists, get their ID
      const { user } = await auth.api.signInEmail({
        body: { email, password: process.env.DEFAULT_USER_PASSWORD! },
      });
      userId = user?.id!;
    }

    if (!userId) throw new Error("Could not get user ID");

    // Ensure organization exists
    const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG || "wxyc";
    const defaultOrgName = process.env.DEFAULT_ORG_NAME || "WXYC 89.3 FM";
    let organizationId: string | null = null;

    try {
      const org = await auth.api.createOrganization({
        body: { name: defaultOrgName, slug: defaultOrgSlug },
      });
      console.log("Created default organization:", org);
      organizationId = org?.id || organizationId;
    } catch {
      const existingOrg = await db
        .select()
        .from(organization)
        .where(eq(organization.slug, defaultOrgSlug))
        .limit(1);

      console.log("Default organization already exists:", existingOrg);
      organizationId = existingOrg?.[0]?.id || organizationId;
    }

    if (!organizationId) throw new Error("Could not determine organization ID");

    // Add user to organization as admin
    try {
      await auth.api.addMember({
        body: {
          organizationId,
          userId,
          role: "admin",
        },
      });
    } catch {
      // User might already be a member, continue
    }
  } catch (error) {
    console.error("Default user setup failed:", error);
  }
};

// Start the server
app.listen(parseInt(port), async () => {
  console.log(`listening on port: ${port}! (auth service)`);

  // Initialize default user after server starts
  await createDefaultUser();
});

export default app;
