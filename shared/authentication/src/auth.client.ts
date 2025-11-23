import { createAuthClient } from "better-auth/client";
import { adminClient, jwtClient, usernameClient, organizationClient } from "better-auth/client/plugins";


export const authClient = createAuthClient({
    
  // Base URL for the auth service
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8082/api/auth",

  plugins:[
    adminClient(),
    usernameClient(),
    jwtClient(),
    organizationClient()
  ]
});