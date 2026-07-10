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
 * FK is satisfied without asking operators to hand-run SQL. Contents mirror
 * both the in-memory trustedClient AND what the plugin's /register handler
 * writes (`node_modules/better-auth/dist/plugins/oidc-provider/index.mjs:868-892`)
 * so a bootstrap row is indistinguishable from a self-registered one.
 *
 * Deliberate design choices:
 *   - Passes `forceAllowId: true` on create so the deterministic
 *     `trusted-<clientId>` PK actually lands in the DB. Without it, the
 *     adapter factory logs a warning and generates a random id
 *     (`@better-auth/core/dist/db/adapter/factory.mjs:417-421`), which
 *     would silently break the `SELECT ... WHERE id LIKE 'trusted-%'`
 *     operator query this module advertises.
 *   - Catches Postgres `unique_violation` on create and falls through to
 *     update, so multi-replica boots (staging Docker Compose, any future
 *     scale-out) don't crash the losing replica when both `findOne` miss
 *     the row and both call `create`.
 *   - Includes `metadata` and `icon` — the plugin schema declares both,
 *     the /register handler persists both, so bootstrap rows do too.
 */

import { oauthApplication } from '@wxyc/database';
import type { DBAdapter } from 'better-auth';
import type { Client } from 'better-auth/plugins';

// Drizzle-inferred row type — single source of truth. If schema.ts adds a
// column, this row type follows without a manual mirror to maintain.
type OauthApplicationRow = typeof oauthApplication.$inferSelect;

// Fields the bootstrap owns from Client config (i.e., that can drift and must
// be refreshed on every boot). Extract so create and update stay in sync — a
// new mutable field added to one branch and forgotten in the other would leave
// updated rows shaped differently from freshly-inserted rows.
type MutableFields = Pick<
  OauthApplicationRow,
  'clientSecret' | 'name' | 'type' | 'disabled' | 'redirectUrls' | 'metadata' | 'icon' | 'updatedAt'
>;

const idForTrustedClient = (clientId: string): string => `trusted-${clientId}`;

// The plugin's registration handler stores `redirectUrls` as a comma-joined
// string (index.mjs:886) and splits back to array in getClient() (line 48).
const encodeRedirectUrls = (urls: readonly string[]): string => urls.join(',');

// `Client.metadata` is `Record<string, any> | null` on the in-memory config;
// the plugin's /register handler serializes it as JSON (`index.mjs:883`).
// Mirror that so a config with `metadata: { foo: 'bar' }` reads back the same
// through both paths.
const encodeMetadata = (metadata: Client['metadata']): string | null =>
  metadata == null ? null : JSON.stringify(metadata);

const buildMutableFields = (client: Client, now: Date): MutableFields => ({
  clientSecret: client.clientSecret ?? null,
  name: client.name ?? client.clientId,
  type: client.type ?? 'web',
  disabled: client.disabled ?? false,
  redirectUrls: encodeRedirectUrls(client.redirectUrls ?? []),
  metadata: encodeMetadata(client.metadata),
  icon: client.icon ?? null,
  updatedAt: now,
});

// Postgres SQLSTATE for `unique_violation`. `postgres` (the driver under
// Drizzle) reports it as `.code`, but Drizzle wraps driver errors in a
// `DrizzleQueryError` and puts the real error on `.cause`. Check both
// locations — same pattern as `extractSqlState` in
// `jobs/flowsheet-metadata-backfill/orchestrate.ts:194-200` and
// `apps/backend/routes/internal-bans.route.ts:162-163`, so tests that throw a
// bare error and prod runs that throw the wrapped form both classify.
const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const code = causeCode ?? (error as { code?: unknown }).code;
  return code === '23505';
};

async function upsertOne(adapter: DBAdapter<Record<string, unknown>>, client: Client): Promise<'created' | 'updated'> {
  const existing = await adapter.findOne<OauthApplicationRow>({
    model: 'oauthApplication',
    where: [{ field: 'clientId', value: client.clientId }],
  });

  const now = new Date();
  const mutable = buildMutableFields(client, now);

  if (!existing) {
    try {
      // `forceAllowId: true` is REQUIRED — without it, the adapter factory
      // strips `data.id` and generates a random one, silently breaking the
      // deterministic id contract. See adapter/factory.mjs:417-421.
      await adapter.create({
        model: 'oauthApplication',
        data: {
          id: idForTrustedClient(client.clientId),
          clientId: client.clientId,
          userId: null,
          createdAt: now,
          ...mutable,
        },
        forceAllowId: true,
      });
      return 'created';
    } catch (error) {
      // Multi-replica boot race: replica A's findOne missed, replica B
      // wrote the row before A's create fired. Fall through to update
      // rather than crashing this replica.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  const row =
    existing ??
    (await adapter.findOne<OauthApplicationRow>({
      model: 'oauthApplication',
      where: [{ field: 'clientId', value: client.clientId }],
    }));

  if (!row) {
    // Vanishingly unlikely: another replica deleted the row between our
    // race-catch and this re-lookup. Surface as an error — the invariant this
    // module maintains has been externally violated.
    throw new Error(`bootstrap: row for clientId=${client.clientId} vanished mid-upsert`);
  }

  await adapter.update({
    model: 'oauthApplication',
    where: [{ field: 'id', value: row.id }],
    update: mutable,
  });
  return 'updated';
}

export async function bootstrapTrustedClients(
  adapter: DBAdapter<Record<string, unknown>>,
  trustedClients: readonly Client[]
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const errors: Error[] = [];

  for (const client of trustedClients) {
    // Per-client isolation: a failure on one trustedClient (transient race
    // whose recovery path also failed, schema drift on one row) shouldn't
    // prevent the others from being upserted. Aggregate errors and re-throw
    // at the end so the caller's Sentry alert still fires but every client
    // gets an attempt.
    try {
      const outcome = await upsertOne(adapter, client);
      if (outcome === 'created') created++;
      else updated++;
    } catch (error) {
      errors.push(
        error instanceof Error ? error : new Error(`bootstrap: unknown error for clientId=${client.clientId}`)
      );
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `bootstrap: ${errors.length} of ${trustedClients.length} trustedClients failed to upsert`
    );
  }

  return { created, updated };
}
