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
export { bootstrapTrustedClients } from './bootstrap-trusted-clients';
export { buildTrustedClients } from './oidc-trusted-clients';
