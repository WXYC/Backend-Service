/**
 * Bootstrap `auth_oauth_application` rows for every `trustedClients` entry in
 * the `oidcProvider` plugin config.
 *
 * The plugin's `getClient()` short-circuits on trustedClients — they are
 * returned from the in-memory config and never touch the DB. Its token- and
 * consent-write paths, however, still FK-reference `oauthApplication.clientId`
 * via the schema declared at
 * `node_modules/better-auth/dist/plugins/oidc-provider/schema.mjs` (materialized
 * by migration 0111). Without a matching row, every trustedClient token
 * exchange 500s with:
 *   insert or update on table "auth_oauth_access_token" violates foreign key
 *   constraint "auth_oauth_access_token_client_id_auth_oauth_application_client"
 *
 * This bootstrap upserts one row per trustedClient at server startup so the
 * FK is satisfied without asking operators to hand-run SQL. Contents don't
 * gate auth (the plugin doesn't read them for trustedClients), but we still
 * write meaningful values so the row is legible when someone inspects
 * `SELECT * FROM auth_oauth_application`.
 *
 * Lives here rather than inline in `apps/auth/app.ts` so it can be tested
 * without instantiating `betterAuth({...})` and pulling in the database
 * adapter, plugin chain, and Sentry init — same rationale as
 * `oidc-trusted-clients.ts` and `oidc-login-page.ts`.
 */

import type { Client } from 'better-auth/plugins';

// Row shape used against the Better Auth Drizzle adapter. Field names are
// camelCase because the adapter translates to the snake_case columns declared
// in `shared/database/src/schema.ts`. Kept structurally-typed rather than
// importing a concrete adapter type so this module doesn't drag in the whole
// better-auth type surface (mirrors how `bootstrap-trusted-clients.test.ts`
// hand-rolls a fake adapter).
interface OauthApplicationRow {
  id: string;
  clientId: string;
  clientSecret: string | null;
  name: string;
  type: string;
  disabled: boolean;
  redirectUrls: string;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AdapterWhereClause {
  field: string;
  value: unknown;
}

interface BootstrapAdapter {
  findOne(args: { model: string; where: AdapterWhereClause[] }): Promise<OauthApplicationRow | null>;
  create(args: { model: string; data: OauthApplicationRow }): Promise<OauthApplicationRow>;
  update(args: {
    model: string;
    where: AdapterWhereClause[];
    update: Partial<OauthApplicationRow>;
  }): Promise<OauthApplicationRow>;
}

interface BootstrapContext {
  adapter: BootstrapAdapter;
}

// Deterministic id derivation. The plugin generates a random id when a client
// self-registers via `/auth/oauth2/register`, but trustedClients never take
// that path — using `trusted-<clientId>` keeps the row stable across container
// restarts and legible to operators (`SELECT ... WHERE id LIKE 'trusted-%'`).
const idForTrustedClient = (clientId: string): string => `trusted-${clientId}`;

// The plugin's registration handler stores `redirectUrls` as a comma-joined
// string (see node_modules/better-auth/dist/plugins/oidc-provider/index.mjs:886)
// and splits back to array in `getClient()` (line 48). Mirror that encoding so
// `SELECT redirect_urls FROM auth_oauth_application` reads the same regardless
// of whether the row was minted by /register or by this bootstrap.
const encodeRedirectUrls = (urls: readonly string[]): string => urls.join(',');

export async function bootstrapTrustedClients(
  context: BootstrapContext,
  trustedClients: readonly Client[]
): Promise<void> {
  for (const client of trustedClients) {
    const existing = await context.adapter.findOne({
      model: 'oauthApplication',
      where: [{ field: 'clientId', value: client.clientId }],
    });

    const now = new Date();

    if (!existing) {
      await context.adapter.create({
        model: 'oauthApplication',
        data: {
          id: idForTrustedClient(client.clientId),
          clientId: client.clientId,
          clientSecret: client.clientSecret ?? null,
          name: client.name ?? client.clientId,
          type: client.type ?? 'web',
          disabled: client.disabled ?? false,
          redirectUrls: encodeRedirectUrls(client.redirectUrls ?? []),
          userId: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      continue;
    }

    // Always refresh mutable fields from config. Skipping the update when
    // values match saves one DB round-trip but adds a branching drift check
    // whose bugs (case sensitivity, array ordering, whitespace) would silently
    // leave stale rows in prod; a single UPDATE per boot is cheap enough that
    // "always refresh" wins on legibility.
    await context.adapter.update({
      model: 'oauthApplication',
      where: [{ field: 'id', value: existing.id }],
      update: {
        clientSecret: client.clientSecret ?? null,
        name: client.name ?? client.clientId,
        type: client.type ?? 'web',
        disabled: client.disabled ?? false,
        redirectUrls: encodeRedirectUrls(client.redirectUrls ?? []),
        updatedAt: now,
      },
    });
  }
}
