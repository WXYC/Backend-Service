// Auth service using Express
import { auth } from "@wxyc/authentication";
import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import { config } from "dotenv";
import express from "express";

// Load environment variables from .env file
config();

const app = express();

// Parse JSON bodies first (needed for auth endpoints)
app.use(express.json());

// Apply CORS globally to all routes (must be before auth handler)
app.use(
  cors({
    origin: process.env.FRONTEND_SOURCE || "*",
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie", "Set-Cookie"],
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
    exposedHeaders: ["Content-Length", "Set-Cookie"],
  })
);

// Mount the Better Auth handler for all auth routes
// app.use() will handle all methods and paths under /api/auth
app.use("/api/auth", toNodeHandler(auth));

const port = process.env.AUTH_PORT || "8082";

// Create default user if needed
const createDefaultUser = async () => {
  if (process.env.CREATE_DEFAULT_USER !== "TRUE") return;

  try {
    const email = process.env.DEFAULT_USER_EMAIL;
    const username = process.env.DEFAULT_USER_USERNAME;
    const password = process.env.DEFAULT_USER_PASSWORD;
    const djName = process.env.DEFAULT_USER_DJ_NAME;
    const realName = process.env.DEFAULT_USER_REAL_NAME;

    const organizationSlug = process.env.DEFAULT_ORG_SLUG;
    const organizationName = process.env.DEFAULT_ORG_NAME;

    if (
      !username ||
      !email ||
      !password ||
      !djName ||
      !realName ||
      !organizationSlug ||
      !organizationName) {
      throw new Error("Default user credentials are not fully set in environment variables.");
    }

    const context = await auth.$context;
    const adapter = context.adapter;

    const internalAdapter = context.internalAdapter;
    const passwordUtility = context.password;

    const existingUser = await internalAdapter.findUserByEmail(email);

    if (existingUser) {
      console.log("Default user already exists, skipping creation.");
      return;
    }

    const newUser = await internalAdapter.createUser({
      // Required
      email: email,
      emailVerified: true,
      name: username,
      username: username,
      // Optional/Additional fields
      createdAt: new Date(),
      updatedAt: new Date(),
      real_name: realName,
      dj_name: djName,
      app_skin: "modern-light"
    });

    const hashedPassword = await passwordUtility.hash(password);
    await internalAdapter.linkAccount({
      accountId: crypto.randomUUID(),
      providerId: "credential",
      password: hashedPassword,
      userId: newUser.id
    });

    let organizationId;

    const existingOrganization = await adapter.findOne<{ id: string }>({
      model: "organization",
      where: [{ field: "slug", value: organizationSlug }],
    });

    if (existingOrganization) {
      organizationId = existingOrganization.id;
    } else {
      const newOrganization = await adapter.create({
        model: "organization",
        data: {
          name: organizationName,
          slug: organizationSlug,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      organizationId = newOrganization.id;
    }

    if (!organizationId) {
      throw new Error("Failed to create or retrieve organization for default user.");
    }

    const existingMembership = await adapter.findOne<{ id: string }>({
      model: "member",
      where: [
        { field: "userId", value: newUser.id },
        { field: "organizationId", value: organizationId }
      ],
    });

    if (existingMembership) {
      throw new Error("Somehow, default user membership already exists for new user.");
    }

    await adapter.create({
      model: "member",
      data: {
        userId: newUser.id,
        organizationId: organizationId,
        createdAt: new Date(),
      }
    });

    console.log("Default user created successfully.");
  } catch (error) {
    console.error("Error creating default user!");
    throw error;
  }
};

// Start the server
app.listen(parseInt(port), async () => {
  console.log(`listening on port: ${port}! (auth service)`);

  // Initialize default user after server starts
  await createDefaultUser();
});

export default app;
