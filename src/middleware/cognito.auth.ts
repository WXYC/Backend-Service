import 'dotenv/config';
import { Response, Request, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USERPOOL_ID ?? '',
  tokenUse: 'access',
  clientId: process.env.DJ_APP_CLIENT_ID ?? '',
});

export const cognitoMiddleware = (permissionsLevel: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const accessToken = req.header('authorization') || '';
    try {
      const verification = await jwtVerifier.verify(accessToken);
      console.log(verification);
      if (!verification['cognito:groups']?.includes(permissionsLevel)) {
        res.status(403).json({ message: 'Forbidden' });
      } else {
        next();
      }
    } catch (e) {
      res.status(403).json({ message: 'Forbidden' });
    }
  };
};
