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
  SignupCooldownEvaluation,
  ReadRecentSignupAttemptsOptions,
  PruneSignupAttemptsOptions,
  StationSignupOutcome,
} from './station-passcode';
