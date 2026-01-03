import {
  account,
  db,
  invitation,
  jwks,
  member,
  organization,
  session,
  user,
  verification,
} from "@wxyc/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  admin,
  jwt,
  organization as organizationPlugin,
  username,
} from "better-auth/plugins";
import { and, eq, sql } from "drizzle-orm";
import { WXYCRoles } from "./auth.roles";

export const auth = betterAuth({
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
      invitation: invitation,
    },
  }),

  // Base URL for the auth service
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8082/api/auth",

  // Trusted origins for CORS
  trustedOrigins: (
    process.env.BETTER_AUTH_TRUSTED_ORIGINS ||
    process.env.FRONTEND_SOURCE ||
    "http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Email+password only (social omitted), admin-only creation is in UI
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    disableSignUp: true,
  },

  // Subdomain-friendly cookie setting (recommended over cross-site cookies)
  /*advanced: {
    crossSubDomainCookies: { enabled: true },
  },*/

  plugins: [
    admin(),
    username(),
    jwt({
      // JWT plugin configuration
      // JWKS endpoint automatically exposed at /api/auth/jwks
      // Custom payload to include organization member role
      jwt: {
        definePayload: async ({ user }) => {
          // Query organization membership to get member role
          if (user?.id) {
            const memberRecord = await db
              .select({ role: member.role })
              .from(member)
              .where(sql`${member.userId} = ${user.id}` as any)
              .limit(1);

            if (memberRecord.length > 0) {
              return {
                ...user,
                role: memberRecord[0].role, // Use organization member role instead of default user role
              };
            }
          }
          // Fallback to default user data if no organization membership found
          return user;
        },
      },
    }),
    organizationPlugin({
      // Configure for single organization model
      allowUserToCreateOrganization: false, // Only admins can create organizations
      organizationLimit: 1, // Users can only be in one organization
      roles: WXYCRoles,
      // Role information is included via custom JWT definePayload function above
    }),
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

  // Admin configuration - organization owners/admins/stationManagers are admins
  admin: {
    // Check if user has admin, owner, or stationManager role in the WXYC organization
    requireAdmin: async (user: any, request?: any) => {
      if (!user?.id) return false;

      try {
        const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;

        if (!defaultOrgSlug) {
          throw new Error(
            "DEFAULT_ORG_SLUG is not set in environment variables."
          );
        }

        // Query the member table to check if user has admin/owner/stationManager role in WXYC org
        const adminMember = await db
          .select({ memberId: member.id })
          .from(member)
          .innerJoin(
            organization,
            sql`${member.organizationId} = ${organization.id}` as any
          )
          .where(
            sql`${member.userId} = ${user.id}
            AND ${organization.slug} = ${defaultOrgSlug}
            AND ${member.role} IN ('admin', 'owner', 'stationManager')` as any
          )
          .limit(1);

        return adminMember.length > 0;
      } catch (error) {
        console.error("Error checking admin status:", error);
        return false;
      }
    },
  },
});

export type Auth = typeof auth;
