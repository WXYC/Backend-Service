import 'dotenv/config';
import { Response, Request, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';

type JwtVerifier =
  | CognitoJwtVerifierSingleUserPool<{ userPoolId: string; tokenUse: 'access'; clientId: string }>
  | MockVerifier;

interface MockVerifier {
  hydrate(): Promise<void>;
  verify(): Promise<CognitoAccessTokenPayload>;
}

const mockVerifier: MockVerifier = {
  hydrate(): Promise<void> {
    return new Promise<void>((resolve) => {
      resolve();
    });
  },
  verify(): Promise<CognitoAccessTokenPayload> {
    return new Promise<CognitoAccessTokenPayload>((resolve) => {
      const mockPayload: CognitoAccessTokenPayload = {
        'cognito:groups': new Array('mock_group'),
        token_use: 'access',
        client_id: 'mock_id',
        version: 0,
        username: 'mock_user',
        scope: 'mock_scope',
        sub: 'mock_sub',
        iss: 'mock_iss',
        exp: 0,
        iat: 0,
        auth_time: 0,
        jti: 'mock_jti',
        origin_jti: 'mock_origin_jti',
      };

      resolve(mockPayload);
    });
  },
};

function NewJwtVerifier(testing: boolean): JwtVerifier {
  if (testing) {
    return mockVerifier;
  }

  return CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USERPOOL_ID ?? '',
    tokenUse: 'access',
    clientId: process.env.DJ_APP_CLIENT_ID ?? '',
  });
}

export const jwtVerifier = NewJwtVerifier(process.env.AUTH_BYPASS === 'true');

export const Roles = {
  mgmt: 'station-management',
  musicDirector: 'music-management',
  stationMgr: 'station-manager',
  dj: 'dj',
};

export const cognitoMiddleware = (...permissionsLevel: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tokenArr = req.header('Authorization')?.split(' ') || [''];
    const accessToken = tokenArr.length == 1 ? tokenArr[0] : tokenArr[1];
    if (process.env.AUTH_BYPASS === 'true') {
      res.locals.decodedJWT = { username: process.env.AUTH_USERNAME };
      next();
    } else {
      try {
        const verification = await jwtVerifier.verify(accessToken); //throws error for invalid tokens
        const groups = verification['cognito:groups'];

        // Roles.dj, just means we expect a valid token. No group check is necessary
        if (!permissionsLevel.includes(Roles.dj) && groups && disjoint(groups, permissionsLevel)) {
          res.status(403).json({ status: 403, message: 'Forbidden' });
        } else {
          res.locals.decodedJWT = verification;
          next();
        }
      } catch (e) {
        // if the auth level is empty and there is no Authorization header,
        // then verify() will result in error and we continue without
        if (permissionsLevel.length == 0) {
          next();
          return;
        }
        // Otherwise we expect a token and if not provided we forbid access
        res.status(403).json({ status: 403, message: 'Forbidden' });
      }
    }
  };
};

const disjoint = <T>(arr1: Array<T>, arr2: Array<T>): Boolean => {
  return !arr1.some((val) => arr2.includes(val));
};
