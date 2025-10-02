// Auth service using Express
import express from 'express';
import cors from 'cors';
import { auth } from "./auth.js";
import { toNodeHandler } from 'better-auth/node';

const app = express();

// Apply CORS globally to all routes
app.use(cors({
  origin: process.env.FRONTEND_SOURCE || "*",
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "Cookie", "Set-Cookie"],
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
  exposedHeaders: ["Content-Length", "Set-Cookie"],
}));

// Parse JSON bodies
app.use(express.json());

// (Optional) a helper endpoint to read session server-side
app.get("/api/auth/session", async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: "Failed to get session" });
  }
});

// Also support POST for token endpoint
app.post("/api/auth/token", async (req, res) => {
  try {
    const session = await auth.api.getToken({ headers: req.headers });
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: "Failed to get token" });
  }
});

// Mount the Better Auth handler for all auth routes
// Use app.use() to handle all methods and paths under /api/auth
app.use("/api/auth", toNodeHandler(auth));

const port = process.env.PORT || "8082";


// Create default user if needed
const createDefaultUser = async () => {
  if (process.env.CREATE_DEFAULT_USER === "TRUE") {
    console.log("🔧 Checking for default user...");
    try {
      const username = process.env.DEFAULT_USER_USERNAME!;
      const available = await auth.api.isUsernameAvailable({ body: {
        username,
      }});
      
      if (!available) {
        console.log("Default user already exists:", username);
        return;
      }
      
      const user = await auth.api.signUpEmail({ body: {
        name: process.env.DEFAULT_USER_NAME!,
        email: process.env.DEFAULT_USER_EMAIL!,
        password: process.env.DEFAULT_USER_PASSWORD!,
        username: process.env.DEFAULT_USER_USERNAME!,
        displayUsername: process.env.DEFAULT_USER_DISPLAY_USERNAME!,
        onboarded: false,
        appSkin: "modern-light",
        role: "station-management", // Default user gets station management role
      }});
      console.log("Default user created:", username);
    } catch (error) {
      console.error("Failed to create default user:", error);
    }
  } else {
    console.log("CREATE_DEFAULT_USER not set to TRUE, skipping default user creation");
  }
};

// Start the server
app.listen(parseInt(port), async () => {
  console.log(`Auth service listening on port: ${port}!`);
  
  // Initialize default user after server starts
  await createDefaultUser();
});

export default app;
