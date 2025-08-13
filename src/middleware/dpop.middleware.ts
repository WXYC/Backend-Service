import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Extend Express Request interface to include locals
declare global {
  namespace Express {
    interface Request {
      locals?: any;
    }
  }
}

export interface DPoPValidationResult {
  isValid: boolean;
  error?: string;
  jkt?: string;
}

export interface DPoPHeader {
  typ: string;
  alg: string;
  jwk: {
    kty: string;
    crv?: string;
    x?: string;
    y?: string;
    n?: string;
    e?: string;
    kid?: string;
  };
}

export interface DPoPPayload {
  htu: string; // HTTP URI
  htm: string; // HTTP method
  iat: number; // Issued at
  exp: number; // Expiration time
  jti: string; // JWT ID
  ath?: string; // Access token hash
}

/**
 * Validates DPoP token and ensures it matches the access token
 */
type ValidateOptions = {
  requireAuthorizationHeader?: boolean;
  skipAccessTokenHashCheck?: boolean;
};

export const validateDPoP = (
  req: Request,
  options: ValidateOptions = { requireAuthorizationHeader: true, skipAccessTokenHashCheck: false }
): DPoPValidationResult => {
  const dpopHeader = req.header('DPoP');
  const authorizationHeader = req.header('Authorization');
  
  if (!dpopHeader) {
    return { isValid: false, error: 'DPoP header is required' };
  }
  
  if (options.requireAuthorizationHeader !== false && !authorizationHeader) {
    return { isValid: false, error: 'Authorization header is required' };
  }

  try {
    // Parse the DPoP token (JWT format)
    const [headerB64, payloadB64, signatureB64] = dpopHeader.split('.');
    
    if (!headerB64 || !payloadB64 || !signatureB64) {
      return { isValid: false, error: 'Invalid DPoP token format' };
    }

    // Decode header and payload
    const header: DPoPHeader = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    const payload: DPoPPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    // Validate token type
    if (header.typ !== 'dpop+jwt') {
      return { isValid: false, error: 'Invalid DPoP token type' };
    }

    // Validate algorithm (ES256, RS256, or EdDSA)
    if (!['ES256', 'RS256', 'EdDSA'].includes(header.alg)) {
      return { isValid: false, error: 'Unsupported DPoP algorithm' };
    }

    // Validate JWK structure
    if (!header.jwk || !header.jwk.kty) {
      return { isValid: false, error: 'Invalid JWK in DPoP header' };
    }

    // Validate expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return { isValid: false, error: 'DPoP token has expired' };
    }

    // Validate issued at time (not too far in the past)
    if (payload.iat < now - 300) { // 5 minutes tolerance
      return { isValid: false, error: 'DPoP token issued too far in the past' };
    }

    // Validate HTTP method
    if (payload.htm !== req.method) {
      return { isValid: false, error: 'DPoP token HTTP method mismatch' };
    }

    // Validate HTTP URI
    const expectedUri = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    if (payload.htu !== expectedUri) {
      return { isValid: false, error: 'DPoP token URI mismatch' };
    }

    // Extract access token hash if present
    if (!options.skipAccessTokenHashCheck && payload.ath) {
      const accessToken = authorizationHeader.replace('Bearer ', '');
      const expectedAth = crypto
        .createHash('sha256')
        .update(accessToken)
        .digest('base64url');
      
      if (payload.ath !== expectedAth) {
        return { isValid: false, error: 'DPoP token access token hash mismatch' };
      }
    }

    // Generate JWK thumbprint for binding
    const jkt = generateJwkThumbprint(header.jwk);
    
    return { isValid: true, jkt };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { isValid: false, error: `DPoP validation error: ${errorMessage}` };
  }
};

/**
 * Generates a JWK thumbprint according to RFC 7638
 */
function generateJwkThumbprint(jwk: any): string {
  // Sort the JWK keys alphabetically and remove undefined values
  const sortedJwk = Object.keys(jwk)
    .sort()
    .reduce((result: any, key: string) => {
      if (jwk[key] !== undefined) {
        result[key] = jwk[key];
      }
      return result;
    }, {});

  // Create canonical JSON representation
  const canonicalJson = JSON.stringify(sortedJwk);
  
  // Generate SHA-256 hash
  const hash = crypto.createHash('sha256').update(canonicalJson).digest();
  
  // Return base64url encoded thumbprint
  return hash.toString('base64url');
}

/**
 * DPoP middleware that validates DPoP tokens
 */
export const dpopMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const validation = validateDPoP(req);
  
  if (!validation.isValid) {
    return res.status(401).json({
      status: 401,
      message: 'DPoP validation failed',
      error: validation.error
    });
  }

  // Store the JWK thumbprint for potential use in access token validation
  req.locals = req.locals || {};
  req.locals.dpopJkt = validation.jkt;
  
  next();
};

/**
 * DPoP proof-only middleware used for token issuance (no Authorization header yet)
 */
export const dpopProofOnlyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const validation = validateDPoP(req, { requireAuthorizationHeader: false, skipAccessTokenHashCheck: true });

  if (!validation.isValid) {
    return res.status(401).json({
      status: 401,
      message: 'DPoP validation failed',
      error: validation.error,
    });
  }

  req.locals = req.locals || {};
  req.locals.dpopJkt = validation.jkt;

  next();
};
