import * as jose from 'jose';
import { db, anonymous_devices, AnonymousDevice } from '@wxyc/database';
import { eq, sql } from 'drizzle-orm';

// Environment configuration with defaults
const JWT_SECRET = process.env.ANON_DEVICE_JWT_SECRET || '';
const TOKEN_EXPIRY_DAYS = parseInt(process.env.ANON_DEVICE_TOKEN_EXPIRY_DAYS || '30', 10);
const REFRESH_THRESHOLD_DAYS = parseInt(process.env.ANON_DEVICE_REFRESH_THRESHOLD_DAYS || '7', 10);

// Validate UUID format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TokenPayload {
  deviceId: string;
  iat: number;
  exp: number;
}

export interface TokenResult {
  token: string;
  expiresAt: Date;
}

export interface DeviceValidationResult {
  valid: boolean;
  device?: AnonymousDevice;
  error?: 'invalid_token' | 'expired_token' | 'blocked' | 'not_found';
  needsRefresh?: boolean;
  newToken?: TokenResult;
}

/**
 * Validates a device ID format (must be a valid UUID)
 */
export const isValidDeviceId = (deviceId: string): boolean => {
  return UUID_REGEX.test(deviceId);
};

/**
 * Gets the JWT secret as a Uint8Array for jose
 */
const getJwtSecret = (): Uint8Array => {
  if (!JWT_SECRET) {
    throw new Error('ANON_DEVICE_JWT_SECRET environment variable is not set');
  }
  return new TextEncoder().encode(JWT_SECRET);
};

/**
 * Generates a JWT token for a device
 */
export const generateToken = async (deviceId: string): Promise<TokenResult> => {
  const secret = getJwtSecret();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + TOKEN_EXPIRY_DAYS);

  const token = await new jose.SignJWT({ deviceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_EXPIRY_DAYS}d`)
    .sign(secret);

  return { token, expiresAt };
};

/**
 * Verifies a JWT token and returns the payload
 */
export const verifyToken = async (token: string): Promise<TokenPayload | null> => {
  try {
    const secret = getJwtSecret();
    const { payload } = await jose.jwtVerify(token, secret);
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
};

/**
 * Checks if a token needs refresh (within threshold days of expiration)
 */
export const tokenNeedsRefresh = (exp: number): boolean => {
  const expirationDate = new Date(exp * 1000);
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() + REFRESH_THRESHOLD_DAYS);
  return expirationDate <= thresholdDate;
};

/**
 * Gets a device by its device ID
 */
export const getDeviceByDeviceId = async (deviceId: string): Promise<AnonymousDevice | null> => {
  const result = await db.select().from(anonymous_devices).where(eq(anonymous_devices.deviceId, deviceId)).limit(1);

  return result[0] || null;
};

/**
 * Registers a new device or returns existing device
 * Returns null if device is blocked
 */
export const registerDevice = async (deviceId: string): Promise<{ device: AnonymousDevice; isNew: boolean } | null> => {
  const existingDevice = await getDeviceByDeviceId(deviceId);

  if (existingDevice) {
    if (existingDevice.blocked) {
      return null;
    }
    return { device: existingDevice, isNew: false };
  }

  const result = await db
    .insert(anonymous_devices)
    .values({
      deviceId,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      blocked: false,
      requestCount: 0,
    })
    .returning();

  return { device: result[0], isNew: true };
};

/**
 * Updates the last seen timestamp and increments request count
 */
export const recordDeviceActivity = async (deviceId: string): Promise<void> => {
  await db
    .update(anonymous_devices)
    .set({
      lastSeenAt: new Date(),
      requestCount: sql`${anonymous_devices.requestCount} + 1`,
    })
    .where(eq(anonymous_devices.deviceId, deviceId));
};

/**
 * Validates a token and device, handling refresh if needed
 */
export const validateTokenAndDevice = async (token: string): Promise<DeviceValidationResult> => {
  // Verify the token
  const payload = await verifyToken(token);
  if (!payload) {
    return { valid: false, error: 'invalid_token' };
  }

  // Get the device
  const device = await getDeviceByDeviceId(payload.deviceId);
  if (!device) {
    return { valid: false, error: 'not_found' };
  }

  // Check if blocked
  if (device.blocked) {
    return { valid: false, device, error: 'blocked' };
  }

  // Check if token needs refresh
  const needsRefresh = tokenNeedsRefresh(payload.exp);
  let newToken: TokenResult | undefined;

  if (needsRefresh) {
    newToken = await generateToken(payload.deviceId);
  }

  // Record activity (fire and forget)
  recordDeviceActivity(payload.deviceId).catch((err) => {
    console.error('[AnonymousDevice] Failed to record device activity:', err);
  });

  return { valid: true, device, needsRefresh, newToken };
};

/**
 * Blocks a device
 */
export const blockDevice = async (deviceId: string, reason: string): Promise<AnonymousDevice | null> => {
  const result = await db
    .update(anonymous_devices)
    .set({
      blocked: true,
      blockedAt: new Date(),
      blockedReason: reason,
    })
    .where(eq(anonymous_devices.deviceId, deviceId))
    .returning();

  return result[0] || null;
};

/**
 * Unblocks a device
 */
export const unblockDevice = async (deviceId: string): Promise<AnonymousDevice | null> => {
  const result = await db
    .update(anonymous_devices)
    .set({
      blocked: false,
      blockedAt: null,
      blockedReason: null,
    })
    .where(eq(anonymous_devices.deviceId, deviceId))
    .returning();

  return result[0] || null;
};
