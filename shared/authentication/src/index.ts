export * from './auth.definition';
export * from './auth.roles';
export * from './auth.middleware';
export * from './auth.username';
export * from './cors-origin';
export * from './device-authorization';
// The one admin-flag predicate. Exported from the barrel so `apps/auth`'s
// provision path consumes it instead of restating the role set (BS#2282).
export { grantsAdminFlag } from './admin-flag-sync';
export { sendAccountSetupEmail } from './email';
// Station signup (BS#2361) sends this directly rather than going through
// better-auth's `sendVerificationEmail` endpoint: that endpoint no-ops for an
// already-`emailVerified` account (see email-verification.mjs's
// `!user.emailVerified` guard), and provisionUser sets `emailVerified: true`
// unconditionally for every caller. Calling it here is a deliberate SES
// deliverability probe, not a verification-state change — see
// apps/auth/station-signup.ts for the reasoning.
export { sendVerificationEmailMessage } from './email';
export { createAndSendAccountSetupInvite } from './account-setup';
export type { AccountSetupInviteInput, AccountSetupInviteResult } from './account-setup';
export { accountSetupTokenExpiresInSeconds, ACCOUNT_SETUP_TOKEN_DEFAULT_SECONDS } from './account-setup-token';
export { revokeOutstandingAccountSetupTokens, ACCOUNT_SETUP_TOKEN_PREFIX } from './revoke-account-setup-tokens';
export { bootstrapTrustedClients } from './bootstrap-trusted-clients';
export { buildTrustedClients } from './oidc-trusted-clients';
// Station-passcode lifecycle (BS#2359). Named individually, not `export *`,
// so internals (encryption helpers, cooldown arithmetic, the advisory-lock
// key) stay private to the module and only the lifecycle surface the four
// downstream issues (#2361-#2364) actually consume is public.
export {
  generateStationPasscode,
  verifyStationPasscode,
  // The two halves of `verifyStationPasscode` (BS#2361 review). The fused
  // call cannot serve an endpoint that must run the passcode gate BEFORE its
  // enumeration-observable existence checks and the use-claim AFTER them;
  // splitting the phases is what lets apps/auth/station-signup.ts do both.
  matchStationPasscode,
  claimStationPasscode,
  revealStationPasscode,
  rotateStationPasscode,
  revokeStationPasscode,
  evaluateSignupCooldown,
  clearSignupCooldown,
  readRecentSignupAttempts,
  pruneSignupAttempts,
  StationPasscodeCapExceededError,
  StationPasscodeDecryptionError,
  // The `revoked_reason` rotateStationPasscode writes when it administratively
  // revokes an active row that will not decrypt (BS#2359 review). Exported so
  // #2362's admin surface can match the marker exactly instead of by prose,
  // and tell "a manager revoked this" apart from "a key rotation retired it".
  STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON,
  // The cooldown hold duration (BS#2361): the endpoint's refusal message
  // tells a caller how long the station-global gate stays closed, so it
  // must read the module's own constant rather than restate the number.
  SIGNUP_COOLDOWN_HOLD_MS,
} from './station-passcode';
export type {
  StationPasscodeDecryptFailureReason,
  GeneratedStationPasscode,
  RotateStationPasscodeOptions,
  RotatedStationPasscode,
  RevokeStationPasscodeOptions,
  RevealedStationPasscode,
  VerifyStationPasscodeOptions,
  VerifyStationPasscodeResult,
  MatchStationPasscodeResult,
  SignupCooldownEvaluation,
  ReadRecentSignupAttemptsOptions,
  PruneSignupAttemptsOptions,
  StationSignupOutcome,
} from './station-passcode';
