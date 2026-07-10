import { assertDefined } from '@wxyc/shared/test-utils';
import type { Client } from 'better-auth/plugins';
import { bootstrapTrustedClients } from '../../../shared/authentication/src/bootstrap-trusted-clients';

// The better-auth `oidcProvider` plugin's `getClient()` short-circuits on
// `trustedClients` (returned from memory, never persisted), but its token /
// consent write paths still FK-reference `oauthApplication.clientId`. Every
// trustedClient token exchange 500s until a matching row exists. This bootstrap
// hook upserts one row per configured trustedClient at server startup so the
// FK is satisfied without asking operators to hand-run SQL after every fresh
// deploy or DB rebuild. See migration 0111 and the plugin schema at
// node_modules/better-auth/dist/plugins/oidc-provider/schema.mjs.

// Hoisted to module scope — parameter defaults are resolved in the enclosing
// scope, not the function body, so declaring these inside `makeFakeAdapter`
// makes `seed: AdapterRow[] = []` a TS2304 ("Cannot find name 'AdapterRow'").
interface AdapterRow {
  id: string;
  clientId: string;
  clientSecret: string | null;
  name: string;
  type: string;
  disabled: boolean;
  redirectUrls: string;
  metadata: string | null;
  icon: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WhereClause {
  field: string;
  value: string;
}

function makeFakeAdapter(seed: AdapterRow[] = []) {
  const rows = new Map<string, AdapterRow>(seed.map((r) => [r.clientId, { ...r }]));
  const calls = { findOne: 0, create: 0, update: 0 };
  let randomIdCounter = 0;

  const adapter = {
    findOne({ model, where }: { model: string; where: WhereClause[] }) {
      calls.findOne++;
      if (model !== 'oauthApplication') throw new Error(`unexpected model ${model}`);
      // Fake only ever gets queried by clientId (findOne pre-create) or by id
      // (findOne post-race for the update-path re-lookup).
      const clientIdClause = where.find((w) => w.field === 'clientId');
      const idClause = where.find((w) => w.field === 'id');
      if (clientIdClause) return Promise.resolve(rows.get(clientIdClause.value) ?? null);
      if (idClause) return Promise.resolve([...rows.values()].find((r) => r.id === idClause.value) ?? null);
      throw new Error('bootstrap should only look up by clientId or id');
    },
    // Emulate the real adapter factory's id-stripping behavior so tests catch
    // any regression on the `forceAllowId: true` argument. See
    // `@better-auth/core/dist/db/adapter/factory.mjs:417-421`.
    create({ model, data, forceAllowId }: { model: string; data: AdapterRow; forceAllowId?: boolean }) {
      calls.create++;
      if (model !== 'oauthApplication') throw new Error(`unexpected model ${model}`);
      const finalData = { ...data };
      if ('id' in finalData && !forceAllowId) {
        finalData.id = `random-${randomIdCounter++}`;
      }
      if (rows.has(finalData.clientId)) {
        // Emulate Postgres unique_violation shape (SQLSTATE 23505) so the
        // race-recovery path can pattern-match on it.
        const err = new Error('duplicate key value violates unique constraint');
        (err as { code?: string }).code = '23505';
        throw err;
      }
      rows.set(finalData.clientId, finalData);
      return Promise.resolve(finalData);
    },
    update({ model, where, update: values }: { model: string; where: WhereClause[]; update: Partial<AdapterRow> }) {
      calls.update++;
      if (model !== 'oauthApplication') throw new Error(`unexpected model ${model}`);
      const idClause = where.find((w) => w.field === 'id');
      if (!idClause) throw new Error('bootstrap should only update by id');
      const existing = [...rows.values()].find((r) => r.id === idClause.value);
      if (!existing) throw new Error(`no row with id ${idClause.value}`);
      Object.assign(existing, values);
      return Promise.resolve(existing);
    },
  };
  return { adapter, rows, calls };
}

// TS is happy with the real DBAdapter shape being wider than our fake — cast
// through `unknown` at the boundary. The fake's structure is what the tests
// actually exercise; the DBAdapter type erasure is just to satisfy the
// impl's declared parameter type.
type FakeAdapter = ReturnType<typeof makeFakeAdapter>['adapter'];
const asAdapter = (fake: FakeAdapter) => fake as unknown as Parameters<typeof bootstrapTrustedClients>[0];

function flowsheetClient(overrides: Partial<Client> = {}): Client {
  const base: Client = {
    clientId: 'flowsheet',
    clientSecret: 'shh',
    redirectUrls: ['http://localhost:8765/auth/callback'],
    name: 'Flowsheet Verifier',
    type: 'web',
    disabled: false,
    icon: undefined,
    metadata: null,
    skipConsent: true,
  };
  return { ...base, ...overrides };
}

describe('bootstrapTrustedClients', () => {
  it('is a no-op when the trustedClients array is empty', async () => {
    const { adapter, calls, rows } = makeFakeAdapter();

    const result = await bootstrapTrustedClients(asAdapter(adapter), []);

    expect(calls).toEqual({ findOne: 0, create: 0, update: 0 });
    expect(rows.size).toBe(0);
    expect(result).toEqual({ created: 0, updated: 0 });
  });

  it('inserts a new row when no oauthApplication exists for the clientId', async () => {
    const { adapter, calls, rows } = makeFakeAdapter();

    const result = await bootstrapTrustedClients(asAdapter(adapter), [flowsheetClient()]);

    expect(calls.findOne).toBe(1);
    expect(calls.create).toBe(1);
    expect(calls.update).toBe(0);
    expect(result).toEqual({ created: 1, updated: 0 });

    const inserted = rows.get('flowsheet');
    assertDefined(inserted, 'flowsheet row');
    expect(inserted).toMatchObject({
      clientId: 'flowsheet',
      name: 'Flowsheet Verifier',
      type: 'web',
      disabled: false,
      redirectUrls: 'http://localhost:8765/auth/callback',
      metadata: null,
      icon: null,
    });
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.updatedAt).toBeInstanceOf(Date);
  });

  it('persists the deterministic id by passing forceAllowId: true to create', async () => {
    // The adapter factory strips `data.id` unless `forceAllowId: true` is
    // passed (@better-auth/core/dist/db/adapter/factory.mjs:417-421). The
    // fake adapter emulates this — a regression that dropped forceAllowId
    // would fail this assertion by writing 'random-0' instead of
    // 'trusted-flowsheet'.
    const { adapter, rows } = makeFakeAdapter();

    await bootstrapTrustedClients(asAdapter(adapter), [flowsheetClient()]);

    const inserted = rows.get('flowsheet');
    assertDefined(inserted, 'flowsheet row');
    expect(inserted.id).toBe('trusted-flowsheet');
  });

  it('joins multiple redirect URLs with a comma when inserting', async () => {
    const { adapter, rows } = makeFakeAdapter();

    await bootstrapTrustedClients(asAdapter(adapter), [
      flowsheetClient({ redirectUrls: ['https://a/cb', 'https://b/cb'] }),
    ]);

    const row = rows.get('flowsheet');
    assertDefined(row, 'flowsheet row');
    expect(row.redirectUrls).toBe('https://a/cb,https://b/cb');
  });

  it('serializes structured metadata as JSON to match the plugin /register storage format', async () => {
    // The plugin's /register handler at oidc-provider/index.mjs:883 does
    // `metadata: metadata ? JSON.stringify(metadata) : null`. Bootstrap must
    // mirror this so /register-minted and bootstrap-minted rows are
    // indistinguishable to any DB reader.
    const { adapter, rows } = makeFakeAdapter();

    await bootstrapTrustedClients(asAdapter(adapter), [flowsheetClient({ metadata: { audience: 'flowsheet' } })]);

    const row = rows.get('flowsheet');
    assertDefined(row, 'flowsheet row');
    expect(row.metadata).toBe('{"audience":"flowsheet"}');
  });

  it('updates existing row on every boot when config drifts (drift-tolerant upsert)', async () => {
    const { adapter, calls, rows } = makeFakeAdapter([
      {
        id: 'trusted-flowsheet',
        clientId: 'flowsheet',
        clientSecret: null,
        name: 'Old Name',
        type: 'web',
        disabled: false,
        redirectUrls: 'https://old-host/cb',
        metadata: null,
        icon: null,
        userId: null,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
      },
    ]);

    await bootstrapTrustedClients(asAdapter(adapter), [
      flowsheetClient({ name: 'New Name', redirectUrls: ['https://new-host/cb'] }),
    ]);

    expect(calls.findOne).toBe(1);
    expect(calls.create).toBe(0);
    expect(calls.update).toBe(1);

    const row = rows.get('flowsheet');
    assertDefined(row, 'flowsheet row');
    expect(row.name).toBe('New Name');
    expect(row.redirectUrls).toBe('https://new-host/cb');
    expect(row.id).toBe('trusted-flowsheet');
    expect(row.createdAt.toISOString()).toBe(new Date('2026-06-01').toISOString());
    expect(row.updatedAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
  });

  it('recovers from a rolling-deploy race by catching unique_violation and falling through to update', async () => {
    // Two replicas boot in parallel. Replica A's findOne misses. Between A's
    // findOne and A's create, Replica B has already written the row.
    // A's create hits SQLSTATE 23505 — we catch it, re-lookup by clientId,
    // and fall through to update. Verifies the fatal-crash on unique
    // violation that earlier revisions had is fixed.
    const { adapter, calls, rows } = makeFakeAdapter();

    // Simulate the race: pre-seed the row into the map AFTER the first
    // findOne would have run. We achieve this by wrapping findOne to seed
    // the row on first call.
    let firstFindOne = true;
    const originalFindOne = adapter.findOne.bind(adapter);
    adapter.findOne = (args: Parameters<typeof originalFindOne>[0]) => {
      if (firstFindOne) {
        firstFindOne = false;
        const result = originalFindOne(args);
        // Between "our" findOne returning null and "our" create firing, the
        // other replica's create lands.
        rows.set('flowsheet', {
          id: 'trusted-flowsheet',
          clientId: 'flowsheet',
          clientSecret: 'racing-replica-secret',
          name: 'Written by racing replica',
          type: 'web',
          disabled: false,
          redirectUrls: 'https://racing/cb',
          metadata: null,
          icon: null,
          userId: null,
          createdAt: new Date('2026-06-01'),
          updatedAt: new Date('2026-06-01'),
        });
        return result;
      }
      return originalFindOne(args);
    };

    const result = await bootstrapTrustedClients(asAdapter(adapter), [flowsheetClient({ name: 'Our config' })]);

    // 1 findOne (returned null) + 1 create (unique_violation) + 1 findOne
    // (re-lookup) + 1 update.
    expect(calls.findOne).toBe(2);
    expect(calls.create).toBe(1);
    expect(calls.update).toBe(1);
    expect(result).toEqual({ created: 0, updated: 1 });
    const finalRow = rows.get('flowsheet');
    assertDefined(finalRow, 'flowsheet row');
    expect(finalRow.name).toBe('Our config');
  });

  it('processes both wiki.js and flowsheet when both are configured', async () => {
    const wikijs: Client = {
      clientId: 'wiki-id',
      clientSecret: 'wiki-secret',
      redirectUrls: ['https://wiki.wxyc.org/login/oidc/callback'],
      name: 'Wiki.js',
      type: 'web',
      disabled: false,
      icon: undefined,
      metadata: null,
      skipConsent: true,
    };

    const { adapter, calls, rows } = makeFakeAdapter();

    const result = await bootstrapTrustedClients(asAdapter(adapter), [wikijs, flowsheetClient()]);

    expect(calls.create).toBe(2);
    expect(result).toEqual({ created: 2, updated: 0 });
    const wikiRow = rows.get('wiki-id');
    const flowsheetRow = rows.get('flowsheet');
    assertDefined(wikiRow, 'wiki-id row');
    assertDefined(flowsheetRow, 'flowsheet row');
    expect(wikiRow.id).toBe('trusted-wiki-id');
    expect(flowsheetRow.id).toBe('trusted-flowsheet');
  });

  it('detects Drizzle-wrapped unique_violation via error.cause.code, not just error.code', async () => {
    // Drizzle wraps postgres-js errors as DrizzleQueryError with the real
    // error on `.cause` (see drizzle-orm/errors.ts, precedented by
    // `apps/backend/routes/internal-bans.route.ts:162-163` and
    // `jobs/flowsheet-metadata-backfill/orchestrate.ts:194-200`). In
    // production, `error.code` is undefined on the wrapper and the code
    // lives at `error.cause.code`. Locks the isUniqueViolation predicate
    // against a regression that only checks `error.code`.
    const { adapter, rows } = makeFakeAdapter();
    // Simulate the full race: create throws DrizzleQueryError shape, and
    // by then the racing replica has written the row (findOne re-lookup
    // finds it, we update).
    const originalCreate = adapter.create.bind(adapter);
    adapter.create = (args: Parameters<typeof originalCreate>[0]) => {
      rows.set(args.data.clientId, {
        id: args.data.id,
        clientId: args.data.clientId,
        clientSecret: 'racing-replica-secret',
        name: 'Written by racing replica',
        type: 'web',
        disabled: false,
        redirectUrls: 'https://racing/cb',
        metadata: null,
        icon: null,
        userId: null,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
      });
      const drizzleWrappedError = new Error('Failed query: insert into "auth_oauth_application" ...');
      (drizzleWrappedError as { cause?: unknown }).cause = { code: '23505', severity: 'ERROR' };
      throw drizzleWrappedError;
    };

    // If the predicate missed .cause.code, this would throw AggregateError
    // (create threw, race-recovery didn't recognize the shape, error bubbled
    // up). Reaching the resolved-with-updated result proves the wrapper
    // shape was detected.
    const result = await bootstrapTrustedClients(asAdapter(adapter), [flowsheetClient({ name: 'Our config' })]);
    expect(result).toEqual({ created: 0, updated: 1 });
    const finalRow = rows.get('flowsheet');
    assertDefined(finalRow, 'flowsheet row');
    expect(finalRow.name).toBe('Our config');
  });

  it('aggregates per-client failures so one bad client does not skip the others', async () => {
    // Wiki.js processes cleanly; flowsheet fails; the aggregate must reflect
    // both — created:1 for wiki (implicitly, via the throw not preventing
    // its earlier success), and one collected error for flowsheet.
    const wikijs: Client = {
      clientId: 'wiki-id',
      clientSecret: 'wiki-secret',
      redirectUrls: ['https://wiki.wxyc.org/login/oidc/callback'],
      name: 'Wiki.js',
      type: 'web',
      disabled: false,
      icon: undefined,
      metadata: null,
      skipConsent: true,
    };

    const { adapter, rows } = makeFakeAdapter();
    // Make ONLY the flowsheet create fail (non-unique-violation error).
    const originalCreate = adapter.create.bind(adapter);
    adapter.create = (args: Parameters<typeof originalCreate>[0]) => {
      if (args.data.clientId === 'flowsheet') throw new Error('flowsheet-specific transient error');
      return originalCreate(args);
    };

    await expect(bootstrapTrustedClients(asAdapter(adapter), [wikijs, flowsheetClient()])).rejects.toThrow(
      /1 of 2 trustedClients failed/
    );

    // Wiki.js row was written; flowsheet was not — but the loop didn't abort
    // before trying flowsheet.
    expect(rows.has('wiki-id')).toBe(true);
    expect(rows.has('flowsheet')).toBe(false);
  });

  it('collects transient adapter errors into an AggregateError so the caller can Sentry-alert', async () => {
    // Caller in apps/auth/app.ts catches and reports to Sentry at level:
    // 'warning' (matching sibling createDefaultUser / syncAdminRoles). This
    // test locks in that this function surfaces failures as an
    // AggregateError so the caller can catch them — a silent try/catch here
    // would defeat that.
    const brokenAdapter = {
      findOne(): Promise<never> {
        return Promise.reject(new Error('DB unreachable'));
      },
      create(): Promise<never> {
        return Promise.reject(new Error('should not be reached'));
      },
      update(): Promise<never> {
        return Promise.reject(new Error('should not be reached'));
      },
    };

    await expect(
      bootstrapTrustedClients(brokenAdapter as unknown as Parameters<typeof bootstrapTrustedClients>[0], [
        flowsheetClient(),
      ])
    ).rejects.toThrow(/1 of 1 trustedClients failed/);
  });
});
