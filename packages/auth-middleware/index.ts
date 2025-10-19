import { Response, Request, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import WxycError from '@wxyc/shared';

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

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    groups?: string[];
  };
}

export const authMiddleware = (...permissionsLevel: string[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const tokenArr = req.header('Authorization')?.split(' ') || [''];
    const accessToken = tokenArr.length == 1 ? tokenArr[0] : tokenArr[1];
    
    if (process.env.AUTH_BYPASS === 'true') {
      req.user = { 
        id: 'mock_user_id',
        username: process.env.AUTH_USERNAME || 'test_user',
        groups: ['mock_group']
      };
      next();
    } else {
      try {
        const verification = await jwtVerifier.verify(accessToken); //throws error for invalid tokens
        const groups = verification['cognito:groups'];

        const allow = !permissionsLevel.length || permissionsLevel.includes(Roles.dj);
        // Roles.dj, just means we expect a valid token. No group check is necessary
        if (!allow && groups && disjoint(groups, permissionsLevel)) {
          res.status(403).json({ status: 403, message: 'Forbidden' });
        } else {
          req.user = {
            id: verification.sub,
            username: verification.username,
            groups: groups
          };
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

// Define role hierarchy - higher roles inherit permissions from lower roles
const ROLE_HIERARCHY = {
  'guest': 0,
  'dj': 1,
  'music-director': 2,
  'station-management': 3
} as const;

type Role = keyof typeof ROLE_HIERARCHY;

// Get user's effective role based on their groups
const getUserRole = (user: AuthenticatedRequest['user']): Role => {
  if (!user || !user.groups) return 'guest';
  
  // Check for role groups in order of hierarchy (highest to lowest)
  if (user.groups.includes('station-management') || user.groups.includes('station-manager')) {
    return 'station-management';
  }
  if (user.groups.includes('music-management') || user.groups.includes('music-director')) {
    return 'music-director';
  }
  if (user.groups.includes('dj')) {
    return 'dj';
  }
  
  return 'guest';
};

const hasRole = (userRole: Role, requiredRoles: Role[]): boolean => {
  const userLevel = ROLE_HIERARCHY[userRole];
  return requiredRoles.some(role => userLevel >= ROLE_HIERARCHY[role]);
};

export const requireRole = (roles: Role[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const userRole = getUserRole(req.user);
    
    if (!hasRole(userRole, roles)) {
      throw new WxycError('Insufficient permissions', 403);
    }

    next();
  };
};

export const requireDJ = requireRole(['dj']);
export const requireMusicDirector = requireRole(['music-director']);
export const requireStationManagement = requireRole(['station-management']);

export type { Role };
export { getUserRole, hasRole, ROLE_HIERARCHY };

const disjoint = <T>(arr1: Array<T>, arr2: Array<T>): Boolean => {
  return !arr1.some((val) => arr2.includes(val));
};

export default {
  authMiddleware,
  requireRole,
  requireDJ,
  requireMusicDirector,
  requireStationManagement,
  Roles,
  jwtVerifier
};
