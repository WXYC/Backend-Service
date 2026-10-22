import type { FeatureAccessResponse } from '@wxyc/shared/dtos';
import { RequestHandler } from 'express';
import { accessAt, audience, FEATURES, type FeatureKey } from '../config/featureAccess.js';
import { memberAccount } from '../services/intake.service.js';
import { featureAccountOf } from '../utils/review-grants.js';

/** Compile-time check, both ways: every registry feature is a key of the contract's response, and every response key is a feature. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a compile-time assertion; nothing reads it
type _ResponseKeysAreFeatureKeys = Expect<Equal<FeatureKey, keyof FeatureAccessResponse>>;

/**
 * GET /feature-access (BS#3530, epic BS#3528)
 *
 * The signed-in account's audience and access for every feature. The role is the account's strongest `auth_member` role
 * and the capabilities are its `auth_user.capabilities`, both read in one `memberAccount` query, not the token's claims,
 * so a promotion or a grant shows at the next load; the token's role is the one `selectMemberRole` minted from a single
 * row (BS#2286) and lags a promotion. Each feature's flag is read once, and `can_see` is decided from that same read.
 * `audience()` never rejects.
 */
export const getFeatureAccess: RequestHandler = async (req, res) => {
  const account = featureAccountOf(await memberAccount(req.auth!.id!));
  const keys = Object.keys(FEATURES) as FeatureKey[];
  const entries = await Promise.all(
    keys.map(async (feature) => {
      const at = await audience(feature);
      return [feature, { audience: at, can_see: accessAt(at, feature, account) }] as const;
    })
  );

  res.set('Cache-Control', 'private, no-store');
  const body: FeatureAccessResponse = Object.fromEntries(entries) as FeatureAccessResponse;
  res.status(200).json(body);
};
