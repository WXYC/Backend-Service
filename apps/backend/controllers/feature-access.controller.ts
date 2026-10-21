import { db, user } from '@wxyc/database';
import { eq } from 'drizzle-orm';
import { RequestHandler } from 'express';
import { accessAt, audience, FEATURES, type Audience, type FeatureKey } from '../config/featureAccess.js';

/**
 * Mirror of the contract's `FeatureAudience`, `FeatureAccessEntry` and `FeatureAccessResponse` (`wxyc-shared/api.yaml`,
 * wxyc-shared#731); private because Backend-Service stays on `@wxyc/shared` 5.4.0. `FeatureAudience` is the registry's
 * own `Audience`, pinned both ways in `tests/unit/routes/feature-access.route.test.ts`.
 */
export type FeatureAudience = Audience;
export interface FeatureAccessEntry {
  audience: FeatureAudience;
  can_see: boolean;
}
export type FeatureAccessResponse = Record<FeatureKey, FeatureAccessEntry>;

/**
 * GET /feature-access (BS#3530, epic BS#3528)
 *
 * The signed-in account's audience and access for every feature. The role is the verified token's; the capabilities are
 * read from `auth_user` (one primary-key read), not the token claim, so a grant shows at the next load. Each feature's
 * flag is read once, and `can_see` is decided from that same read. `audience()` never rejects.
 */
export const getFeatureAccess: RequestHandler = async (req, res) => {
  const [row] = await db
    .select({ capabilities: user.capabilities })
    .from(user)
    .where(eq(user.id, req.auth!.id!))
    .limit(1);
  const account = { role: req.auth?.role, capabilities: row?.capabilities ?? [] };
  const keys = Object.keys(FEATURES) as FeatureKey[];
  const entries = await Promise.all(
    keys.map(async (feature) => {
      const at = await audience(feature);
      return [feature, { audience: at, can_see: accessAt(at, feature, account) }] as const;
    })
  );

  res.set('Cache-Control', 'private, no-store');
  res.status(200).json(Object.fromEntries(entries));
};
