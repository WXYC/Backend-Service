import { Router } from 'express';
import { dpopProofOnlyMiddleware } from '../middleware/dpop.middleware.js';

export const token_route = Router();

// For clients without Cognito, issue a short-lived local token bound to DPoP JKT
// This is a minimal opaque token for demo; in production use JWT with signing.

token_route.post('/dpop', dpopProofOnlyMiddleware, async (req, res) => {
  try {
    const jkt: string | undefined = req.locals?.dpopJkt;
    if (!jkt) {
      return res.status(400).json({ status: 400, message: 'Missing DPoP thumbprint' });
    }

    // Create an opaque token that encodes jkt and expiry
    const expiresInSeconds = 3600; // 1h
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const tokenPayload = JSON.stringify({ jkt, exp });
    const token = Buffer.from(tokenPayload).toString('base64url');

    res.status(200).json({ access_token: token, token_type: 'Bearer', expires_in: expiresInSeconds });
  } catch (e) {
    res.status(500).json({ status: 500, message: 'Failed to issue token' });
  }
});
