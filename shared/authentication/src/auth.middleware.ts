import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { auth } from "./auth.definition";
import type { AccessControlStatement, WXYCRole } from "./auth.roles";

export interface WXYCAuthJwtPayload extends JWTPayload {
    id: string;
    organizationId: string;
    role: WXYCRole;
    [key: string]: unknown;
}

const issuer = process.env.BETTER_AUTH_JWT_ISSUER;
const audience = process.env.BETTER_AUTH_JWT_AUDIENCE;
const jwksUrl = process.env.BETTER_AUTH_JWKS_URL;

if (!jwksUrl) {
    throw new Error("BETTER_AUTH_JWKS_URL environment variable is not set.");
}

const JWKS = createRemoteJWKSet(new URL(jwksUrl));

async function verify(token: string) {
    if (!issuer || !audience) {
        throw new Error("JWT verification environment variables are not properly set.");
    }

    try {
        const { payload } = await jwtVerify(token, JWKS, {
            issuer: issuer,
            audience: audience,
        });

        return payload as WXYCAuthJwtPayload;
    }
    catch (error) {
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
        const header = req.headers.authorization;

        if (!header || !header.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized: Missing or invalid Authorization header." });
        }

        const token = header.slice("Bearer ".length).trim();

        try {
            const payload = await verify(token);

            req.auth = payload;

            const isAuthorized = auth.api.hasPermission({
                body: {
                    permissions: required,
                    organizationId: payload.organizationId,
                },
                headers: new Headers(req.headers as HeadersInit)
            })

            if (!isAuthorized) {
                return res.status(403).json({ error: "Forbidden: Insufficient permissions." });
            }

            return next();
        }
        catch (error) {
            console.error("Error verifying JWT:", error);
            return res.status(401).json({ error: "Unauthorized: Invalid token." });
        }
    }
};