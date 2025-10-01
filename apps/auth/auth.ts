// auth.ts (runs on your auth server)
import { accounts, db, sessions, users, verifications, jwkss } from "@wxyc/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, username } from "better-auth/plugins";
import { config } from "dotenv";

// Load environment variables from project root
config({ path: "../../.env" });

export const auth: any = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      jwks: jwkss
    },
  }),

  // Base URL for the auth service
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost/api/auth",

  // Trusted origins for CORS
  trustedOrigins: [process.env.FRONTEND_SOURCE || "http://localhost:3000"],

  // Email+password only (social omitted), admin-only creation is in your UI
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },

  // Subdomain-friendly cookie setting (recommended over cross-site cookies)
  /*advanced: {
    crossSubDomainCookies: { enabled: true },
  },*/

  plugins: [admin(), username(), jwt()],

  // Enable username-based login
  username: { enabled: true },

  user: {
    ...users,
    additionalFields: {
      realName: { type: "string", required: false },
      djName: { type: "string", required: false },
      onboarded: { type: "boolean", required: true, default: false },
      appSkin: { type: "string", required: true, default: "modern-light" },
    },
  },
});
