import 'dotenv/config';
import { RequestHandler } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USERPOOL_ID ?? '',
  tokenUse: 'access',
  clientId: process.env.DJ_APP_CLIENT_ID ?? '',
});

export const cognitoMiddleware: RequestHandler = async (req, res, next) => {
  const accessToken = req.header('authorization') || '';
  try {
    const verification = await jwtVerifier.verify(accessToken);
    console.log(verification);
    next();
  } catch (e) {
    res.status(403).json({ message: 'Forbidden' });
  }
};
