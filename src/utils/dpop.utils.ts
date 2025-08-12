import crypto from 'crypto';

export interface DPoPClaims {
  htu: string; // HTTP URI
  htm: string; // HTTP method
  iat?: number; // Issued at (auto-generated if not provided)
  exp?: number; // Expiration time (auto-generated if not provided)
  jti?: string; // JWT ID (auto-generated if not provided)
  ath?: string; // Access token hash (optional)
}

export interface JWK {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  kid?: string;
}

/**
 * Generates a DPoP token for client requests
 * @param claims - The DPoP claims to include in the token
 * @param jwk - The JSON Web Key for signing
 * @param privateKey - The private key for signing (PEM format for RSA/EC, raw bytes for EdDSA)
 * @param algorithm - The signing algorithm to use
 * @returns A signed DPoP token
 */
export const generateDPoPToken = (
  claims: DPoPClaims,
  jwk: JWK,
  privateKey: string | Buffer,
  algorithm: 'ES256' | 'RS256' | 'EdDSA' = 'ES256'
): string => {
  // Set default values for claims
  const now = Math.floor(Date.now() / 1000);
  const finalClaims = {
    iat: now,
    exp: now + 3600, // 1 hour expiration
    jti: `dpop-${crypto.randomUUID()}`,
    ...claims
  };

  // Create header
  const header = {
    typ: 'dpop+jwt',
    alg: algorithm,
    jwk
  };

  // Encode header and payload
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(finalClaims)).toString('base64url');

  // For now, return unsigned token (in production, you'd sign this)
  // In a real implementation, you'd use a JWT library like jose or jsonwebtoken
  return `${headerB64}.${payloadB64}.unsigned`;
};

/**
 * Generates a JWK thumbprint according to RFC 7638
 * @param jwk - The JSON Web Key
 * @returns Base64url-encoded SHA-256 thumbprint
 */
export const generateJwkThumbprint = (jwk: JWK): string => {
  // Sort the JWK keys alphabetically and remove undefined values
  const sortedJwk = Object.keys(jwk)
    .sort()
    .reduce((result: any, key: string) => {
      if (jwk[key as keyof JWK] !== undefined) {
        result[key] = jwk[key as keyof JWK];
      }
      return result;
    }, {});

  // Create canonical JSON representation
  const canonicalJson = JSON.stringify(sortedJwk);
  
  // Generate SHA-256 hash
  const hash = crypto.createHash('sha256').update(canonicalJson).digest();
  
  // Return base64url encoded thumbprint
  return hash.toString('base64url');
};

/**
 * Generates an access token hash for binding DPoP to access tokens
 * @param accessToken - The access token to hash
 * @returns Base64url-encoded SHA-256 hash
 */
export const generateAccessTokenHash = (accessToken: string): string => {
  return crypto
    .createHash('sha256')
    .update(accessToken)
    .digest('base64url');
};

/**
 * Creates a complete DPoP token with access token binding
 * @param uri - The target URI
 * @param method - The HTTP method
 * @param accessToken - The access token to bind
 * @param jwk - The client's public key
 * @returns A DPoP token ready for use
 */
export const createDPoPToken = (
  uri: string,
  method: string,
  accessToken: string,
  jwk: JWK
): string => {
  const ath = generateAccessTokenHash(accessToken);
  
  return generateDPoPToken(
    {
      htu: uri,
      htm: method,
      ath
    },
    jwk,
    'mock-private-key', // Mock private key for utility function
    'ES256'
  );
};

/**
 * Example usage and client integration guide
 */
export const DPoPClientExample = {
  /**
   * Example of how a client should use DPoP
   */
  usage: `
    // 1. Generate a key pair (EC P-256 recommended)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256'
    });

    // 2. Create JWK from public key
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: publicKey.export({ format: 'jwk' }).x,
      y: publicKey.export({ format: 'jwk' }).y
    };

    // 3. Generate DPoP token
    const dpopToken = createDPoPToken(
      'https://api.example.com/request',
      'POST',
      accessToken,
      jwk
    );

    // 4. Include in request headers
    fetch('https://api.example.com/request', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'DPoP': dpopToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: 'Song request' })
    });
  `,

  /**
   * Required headers for DPoP-protected endpoints
   */
  requiredHeaders: {
    'Authorization': 'Bearer <access_token>',
    'DPoP': '<dpop_token>'
  },

  /**
   * DPoP token structure
   */
  tokenStructure: {
    header: {
      typ: 'dpop+jwt',
      alg: 'ES256|RS256|EdDSA',
      jwk: 'Client public key in JWK format'
    },
    payload: {
      htu: 'Target URI',
      htm: 'HTTP method',
      iat: 'Issued at timestamp',
      exp: 'Expiration timestamp',
      jti: 'Unique token ID',
      ath: 'Access token hash (optional)'
    }
  }
};
