import { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { authClient } from "./auth.client";
import { AccessControlStatement, WXYCRole, WXYCRoles } from "./auth.roles";

export type WXYCAuthJwtPayload  = JWTPayload & {
    id: string;
    email: string;
    role: WXYCRole;
};

const issuer = process.env.BETTER_AUTH_ISSUER;
const audience = process.env.BETTER_AUTH_AUDIENCE;
const jwksUrl = process.env.BETTER_AUTH_JWKS_URL;

if (!jwksUrl) {
  throw new Error("BETTER_AUTH_JWKS_URL environment variable is not set.");
}

const JWKS = createRemoteJWKSet(new URL(jwksUrl));

async function verify(token: string) {
  if (!issuer || !audience) {
    throw new Error(
      "JWT verification environment variables are not properly set."
    );
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: issuer,
      audience: audience,
    });

    return payload as WXYCAuthJwtPayload;
  } catch (error) {
    throw new Error(`JWT verification failed: ${error}`);
  }
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: Awaited<ReturnType<typeof verify>>;
  }
}

export type RequiredPermissions = {
  [K in keyof AccessControlStatement]?: AccessControlStatement[K][number][];
};

export function requirePermissions(required: RequiredPermissions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.AUTH_BYPASS === "true") {
      return next();
    }

    const { data, error } = await authClient.token();

    if (error || !data) {
      return res.status(401).json({ error: "Unauthorized: Invalid token." });
    }

    try {
      const payload = await verify(data.token);

      req.auth = payload;

      const roleImpl = WXYCRoles[payload.role];
      if (!roleImpl) {
        return res.status(403).json({ error: "Forbidden: Invalid role." });
      }

      const ok = Object.entries(required).every(([resource, actions]) => {
        if (!actions || actions.length === 0) return true;
  
        const authorize = roleImpl.authorize as (
          request: RequiredPermissions
        ) => { success: boolean };
        
        const result = authorize({
          [resource]: actions,
        } as RequiredPermissions);
        
        return result.success;
      });
  
      if (!ok) {
        return res.status(403).json({ error: "Forbidden: insufficient permissions" });
      }

      return next();
    } catch (error) {
      console.error("Error verifying JWT:", error);
      return res.status(401).json({ error: "Unauthorized: Invalid token." });
    }
  };
}
