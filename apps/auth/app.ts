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
      const email = process.env.DEFAULT_USER_EMAIL!;
      
      // Check if username is available
      const available = await auth.api.isUsernameAvailable({ 
        body: { username }
      });
      
      if (!available) {
        console.log("Default user already exists:", username);
        return;
      }
      
      // Use signUp API but without the invalid fields
      const user = await auth.api.signUpEmail({
        body: {
          name: process.env.DEFAULT_USER_NAME!,
          email: email,
          password: process.env.DEFAULT_USER_PASSWORD!,
          username: username,
          displayUsername: process.env.DEFAULT_USER_DISPLAY_USERNAME!,
          appSkin: "modern-light",
        },
      });
      
      console.log("Default user created:", username);
      
      // Ensure WXYC organization exists, then add user to it
      try {
        // First, try to create the WXYC organization (will fail if it already exists)
        try {
          await auth.api.createOrganization({
            body: {
              name: "WXYC 89.3 FM",
              slug: "wxyc",
            },
          });
          console.log("WXYC organization created");
        } catch (createOrgError) {
          // Organization probably already exists, which is fine
          console.log("WXYC organization already exists or creation failed");
        }
        
        // Now add the user to the organization with admin role
        await auth.api.addMember({
          body: {
            organizationId: "wxyc-org",
            userId: user.data.user.id,
            role: "admin", // Station management role in organization
          },
        });
        console.log("Default user added to WXYC organization with admin role");
      } catch (orgError) {
        console.error("Failed to add user to organization:", orgError);
      }
      
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
