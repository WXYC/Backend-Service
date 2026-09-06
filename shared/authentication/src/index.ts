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
  // The read-only, never-decrypting view of station_passcode behind BS#2362's
  // status endpoint. Kept in the module so `station_passcode` keeps exactly
  // one owner of its SQL, and so the state classifier stays beside the
  // active/inactive predicates it has to agree with.
  readStationPasscodeStates,
  classifyStationPasscodeState,
  revokeStationPasscode,
  evaluateSignupCooldown,
  clearSignupCooldown,
  // The cooldown's own tunables. BS#2361's endpoint needs the hold duration
  // for its refusal message ("the gate stays closed for N minutes"), and
  // BS#2362's status response needs all three so it can describe the rule it
  // is reporting against ("21 failures in 10 minutes holds for 15") — either
  // way the number has to come from the module's own constant rather than be
  // restated by a caller.
  SIGNUP_COOLDOWN_WINDOW_MS,
  SIGNUP_COOLDOWN_HOLD_MS,
  SIGNUP_COOLDOWN_THRESHOLD,
  readRecentSignupAttempts,
  pruneSignupAttempts,
  StationPasscodeCapExceededError,
  StationPasscodeDecryptionError,
  // The `revoked_reason` rotateStationPasscode writes when it administratively
  // revokes an active row that will not decrypt (BS#2359 review). Exported so
  // #2362's admin surface can match the marker exactly instead of by prose,
  // and tell "a manager revoked this" apart from "a key rotation retired it".
  STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON,
} from './station-passcode';
export type {
  StationPasscodeDecryptFailureReason,
  GeneratedStationPasscode,
  RotateStationPasscodeOptions,
  RotatedStationPasscode,
  RevokeStationPasscodeOptions,
  RevealedStationPasscode,
  StationPasscodeState,
  StationPasscodeStateRow,
  ReadStationPasscodeStatesOptions,
  VerifyStationPasscodeOptions,
  VerifyStationPasscodeResult,
  MatchStationPasscodeResult,
  SignupCooldownEvaluation,
  ReadRecentSignupAttemptsOptions,
  PruneSignupAttemptsOptions,
  StationSignupOutcome,
} from './station-passcode';
