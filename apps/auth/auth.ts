// auth.ts (runs on your auth server)
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username, jwt } from "better-auth/plugins";
import { db } from "@wxyc/database";

export const auth: any = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,
  database: drizzleAdapter(db, { provider: "pg", usePlural: true }),

  // Email+password only (social omitted), admin-only creation is in your UI
  emailAndPassword: { enabled: true, requireEmailVerification: false },

  // Subdomain-friendly cookie setting (recommended over cross-site cookies)
  advanced: {
    crossSubDomainCookies: { enabled: true },
  },

  plugins: [admin(), username(), jwt()],

  user: {
    additionalFields: {
      realName: { type: "string", required: false },
      djName: { type: "string", required: false },
      onboarded: { type: "boolean", required: true, default: false },
      appSkin: { type: "string", required: true, default: "modern-light" },
    },
  },
});
