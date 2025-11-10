import { db, user, session, account, verification, jwks, organization, member, invitation } from "@wxyc/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, username, organization } from "better-auth/plugins";
import { config } from "dotenv";
import { sql } from "drizzle-orm";

// Load environment variables from project root
config({ path: "../../.env" });

export const auth: any = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: user,
      session: session,
      account: account,
      verification: verification,
      jwks: jwks,
      organization: organization,
      member: member,
      invitation: invitation
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

  plugins: [
    admin(), 
    username(), 
    jwt(), 
    organization({
      // Configure for single organization model
      allowUserToCreateOrganization: false, // Only admins can create organizations
      organizationLimit: 1, // Users can only be in one organization
      roles: {
        // Define the three roles for WXYC
        member: {
          name: "Member",
          description: "Basic member access"
        },
        dj: {
          name: "DJ",
          description: "DJ access to flowsheet and library"
        },
        "music-director": {
          name: "Music Director", 
          description: "Music Director access to manage library and rotation"
        },
        admin: {
          name: "Station Management",
          description: "Full administrative access"
        }
      }
    })
  ],

  // Enable username-based login
  username: { enabled: true },

  user: {
    additionalFields: {
      realName: { type: "string", required: false },
      djName: { type: "string", required: false },
      appSkin: { type: "string", required: true, default: "modern-light" },
    },
  },

  // Admin configuration - organization owners/admins are admins
  admin: {
    // Check if user has admin or owner role in the WXYC organization
    requireAdmin: async (user: any, request?: any) => {
      if (!user?.id) return false;

      try {
        // Query the member table to check if user has admin/owner role in WXYC org
        const adminMember = await db
          .select()
          .from(member)
          .where(sql`${member.userId} = ${user.id} AND ${member.organizationId} = 'wxyc-org' AND ${member.role} IN ('admin', 'owner')`)
          .limit(1);

        return adminMember.length > 0;
      } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
      }
    },
  },
});