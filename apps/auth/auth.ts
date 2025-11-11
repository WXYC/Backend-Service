import { db, user, session, account, verification, jwks, organization, member, invitation } from "@wxyc/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, defaultRoles, jwt, username, organization as organizationPlugin } from "better-auth/plugins";
import { config } from "dotenv";
import { sql } from "drizzle-orm";

// Load environment variables from project root
config();

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
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8082/api/auth",

  // Trusted origins for CORS
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.FRONTEND_SOURCE || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

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
    organizationPlugin({
      // Configure for single organization model
      allowUserToCreateOrganization: false, // Only admins can create organizations
      organizationLimit: 1, // Users can only be in one organization
      roles: {
        ...defaultRoles,
        dj: defaultRoles.member,
        "music-director": defaultRoles.admin,
      }
    })
  ],

  // Enable username-based login
  username: { enabled: true },

  user: {
    additionalFields: {
      realName: { type: "string", required: false },
      djName: { type: "string", required: false },
      appSkin: { type: "string", required: true, defaultValue: "modern-light" },
    },
  },

  // Admin configuration - organization owners/admins are admins
  admin: {
    // Check if user has admin or owner role in the WXYC organization
    requireAdmin: async (user: any, request?: any) => {
      if (!user?.id) return false;

      try {
        const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG || "wxyc";
        // Query the member table to check if user has admin/owner role in WXYC org
        const adminMember = await db
          .select({ memberId: member.id })
          .from(member)
          .innerJoin(organization, sql`${member.organizationId} = ${organization.id}` as any)
          .where(
            sql`${member.userId} = ${user.id}
            AND ${organization.slug} = ${defaultOrgSlug}
            AND ${member.role} IN ('admin', 'owner')` as any
          )
          .limit(1);

        return adminMember.length > 0;
      } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
      }
    },
  },
});