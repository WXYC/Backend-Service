# DPoP (Demonstrating Proof of Possession) Integration Guide

## Overview

DPoP (Demonstrating Proof of Possession) is a security mechanism that binds access tokens to a specific client by requiring cryptographic proof that the client possesses the private key associated with the token. This prevents token theft and replay attacks.

## How DPoP Works

1. **Client generates a key pair** (typically EC P-256)
2. **Client creates a DPoP token** containing:
   - Target URI and HTTP method
   - Timestamps (issued at, expiration)
   - Access token hash (optional binding)
   - Client's public key (JWK format)
3. **Client signs the token** with their private key
4. **Client sends both tokens** in request headers
5. **Server validates** the DPoP token and ensures it matches the access token

## Protected Endpoints

The following endpoints now require DPoP validation:

- `POST /request` - Song request submission

## Required Headers

```http
Authorization: Bearer <access_token>
DPoP: <dpop_token>
```

## DPoP Token Structure

### Header
```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "base64url-encoded-x-coordinate",
    "y": "base64url-encoded-y-coordinate"
  }
}
```

### Payload
```json
{
  "htu": "https://api.example.com/request",
  "htm": "POST",
  "iat": 1640995200,
  "exp": 1640998800,
  "jti": "unique-token-id",
  "ath": "access-token-hash-optional"
}
```

## Client Implementation Examples

### JavaScript/Node.js

```javascript
import crypto from 'crypto';

// 1. Generate key pair
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256'
});

// 2. Export public key as JWK
const jwk = publicKey.export({ format: 'jwk' });

// 3. Create DPoP token
const createDPoPToken = (uri, method, accessToken) => {
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk
  };
  
  const payload = {
    htu: uri,
    htm: method,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: `dpop-${crypto.randomUUID()}`,
    ath: crypto.createHash('sha256').update(accessToken).digest('base64url')
  };
  
  // In production, sign this with your JWT library
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  return `${headerB64}.${payloadB64}.signature`;
};

// 4. Use in requests
const dpopToken = createDPoPToken(
  'https://api.example.com/request',
  'POST',
  accessToken
);

fetch('https://api.example.com/request', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + accessToken,
    'DPoP': dpopToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ message: 'Song request' })
});
```

### Python

```python
import jwt
import json
import base64
import hashlib
import uuid
import time
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# 1. Generate key pair
private_key = ec.generate_private_key(ec.SECP256R1())
public_key = private_key.public_key()

# 2. Export public key as JWK
public_numbers = public_key.public_numbers()
jwk = {
    "kty": "EC",
    "crv": "P-256",
    "x": base64.urlsafe_b64encode(public_numbers.x.to_bytes(32, 'big')).decode('utf-8').rstrip('='),
    "y": base64.urlsafe_b64encode(public_numbers.y.to_bytes(32, 'big')).decode('utf-8').rstrip('=')
}

# 3. Create DPoP token
def create_dpop_token(uri, method, access_token):
    header = {
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": jwk
    }
    
    payload = {
        "htu": uri,
        "htm": method,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
        "jti": f"dpop-{uuid.uuid4()}",
        "ath": base64.urlsafe_b64encode(hashlib.sha256(access_token.encode()).digest()).decode('utf-8').rstrip('=')
    }
    
    # Sign the token
    token = jwt.encode(payload, private_key, algorithm='ES256', headers=header)
    return token

# 4. Use in requests
import requests

dpop_token = create_dpop_token(
    'https://api.example.com/request',
    'POST',
    access_token
)

response = requests.post(
    'https://api.example.com/request',
    headers={
        'Authorization': f'Bearer {access_token}',
        'DPoP': dpop_token,
        'Content-Type': 'application/json'
    },
    json={'message': 'Song request'}
)
```

## Security Considerations

### Key Management
- **Store private keys securely** - Never expose private keys in client-side code
- **Use hardware security modules (HSM)** for production environments
- **Rotate keys regularly** - Implement key rotation policies

### Token Validation
- **Verify expiration** - DPoP tokens expire after 1 hour
- **Check timestamps** - Reject tokens issued too far in the past
- **Validate URI and method** - Ensure token matches the actual request

### Best Practices
- **Use EC P-256** - Recommended algorithm for most use cases
- **Include access token hash** - Provides stronger binding between tokens
- **Implement token replay protection** - Use unique JTI values
- **Monitor for suspicious activity** - Log failed DPoP validations

## Error Handling

### Common Error Responses

```json
{
  "status": 401,
  "message": "DPoP validation failed",
  "error": "DPoP header is required"
}
```

### Error Types
- `DPoP header is required` - Missing DPoP header
- `Authorization header is required` - Missing access token
- `Invalid DPoP token format` - Malformed token structure
- `Invalid DPoP token type` - Wrong token type
- `Unsupported DPoP algorithm` - Algorithm not supported
- `DPoP token has expired` - Token past expiration
- `DPoP token issued too far in the past` - Token too old
- `DPoP token HTTP method mismatch` - Method doesn't match
- `DPoP token URI mismatch` - URI doesn't match
- `DPoP token access token hash mismatch` - Hash binding failed

## Testing

### Test Environment
- DPoP validation is enabled in all environments
- Use the provided test utilities to generate mock tokens
- Test with both valid and invalid tokens

### Mock Token Generation
```javascript
// Use the createMockDPoPToken function in tests
const mockDPoP = createMockDPoPToken();
```

## Migration Guide

### Existing Clients
1. **Generate key pair** for DPoP signing
2. **Update request logic** to include DPoP tokens
3. **Test integration** with new validation
4. **Deploy updates** to production

### New Clients
1. **Implement DPoP** from the start
2. **Follow security best practices** for key management
3. **Use provided utilities** for token generation

## Support

For questions about DPoP integration:
- Check this documentation
- Review the test examples
- Contact the development team
- Refer to RFC 9449 (DPoP specification)
