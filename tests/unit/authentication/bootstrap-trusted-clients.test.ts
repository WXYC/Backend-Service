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

interface AdapterRow {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string | null;
  redirectUrls: string;
  type: string;
  disabled: boolean;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakeAdapter(seed: AdapterRow[] = []) {
  const rows = new Map<string, AdapterRow>(seed.map((r) => [r.clientId, { ...r }]));
  const calls = { findOne: 0, create: 0, update: 0 };

  // Bootstrap only ever queries by `clientId` or `id`; both are strings. Typing
  // `where.value` narrowly here saves a `String(unknown)` cast that lints as
  // "will use Object's default stringification format".
  interface WhereClause {
    field: string;
    value: string;
  }

  const adapter = {
    findOne({ model, where }: { model: string; where: WhereClause[] }) {
      calls.findOne++;
      if (model !== 'oauthApplication') throw new Error(`unexpected model ${model}`);
      const clause = where.find((w) => w.field === 'clientId');
      if (!clause) throw new Error('bootstrap should only look up by clientId');
      return Promise.resolve(rows.get(clause.value) ?? null);
    },
    create({ model, data }: { model: string; data: AdapterRow }) {
      calls.create++;
      if (model !== 'oauthApplication') throw new Error(`unexpected model ${model}`);
      if (rows.has(data.clientId)) throw new Error(`duplicate clientId ${data.clientId}`);
      rows.set(data.clientId, { ...data });
      return Promise.resolve(data);
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

// Small helper to satisfy `@typescript-eslint/no-non-null-assertion` while still
// getting a narrowed value — Map.get returns V|undefined and we want to fail
// the test loudly if the row we expected to see just isn't there.
function must<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

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

    await bootstrapTrustedClients({ adapter }, []);

    expect(calls).toEqual({ findOne: 0, create: 0, update: 0 });
    expect(rows.size).toBe(0);
  });

  it('inserts a new row when no oauthApplication exists for the clientId', async () => {
    const { adapter, calls, rows } = makeFakeAdapter();

    await bootstrapTrustedClients({ adapter }, [flowsheetClient()]);

    expect(calls.findOne).toBe(1);
    expect(calls.create).toBe(1);
    expect(calls.update).toBe(0);

    const inserted = must(rows.get('flowsheet'), 'flowsheet row');
    // Storage shape (comma-joined redirectUrls) matches the plugin's registration handler
    // at node_modules/better-auth/dist/plugins/oidc-provider/index.mjs:886.
    expect(inserted).toMatchObject({
      clientId: 'flowsheet',
      name: 'Flowsheet Verifier',
      type: 'web',
      disabled: false,
      redirectUrls: 'http://localhost:8765/auth/callback',
    });
    // Timestamps are populated so a downstream migration that adds NOT NULL
    // to `created_at`/`updated_at` doesn't retroactively break bootstrap.
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.updatedAt).toBeInstanceOf(Date);
  });

  it('joins multiple redirect URLs with a comma when inserting', async () => {
    const { adapter, rows } = makeFakeAdapter();

    await bootstrapTrustedClients({ adapter }, [flowsheetClient({ redirectUrls: ['https://a/cb', 'https://b/cb'] })]);

    expect(must(rows.get('flowsheet'), 'flowsheet row').redirectUrls).toBe('https://a/cb,https://b/cb');
  });

  it('uses a deterministic id derived from clientId so re-runs on other envs match by findOne', async () => {
    // The id column is a varchar PK; the plugin generates a random id when a
    // client self-registers via /auth/oauth2/register, but that path never
    // runs for trustedClients. A deterministic derivation keeps the row
    // stable across container restarts, so an operator inspecting the DB can
    // recognize which row belongs to which trustedClient config entry.
    const { adapter, rows } = makeFakeAdapter();

    await bootstrapTrustedClients({ adapter }, [flowsheetClient()]);

    expect(must(rows.get('flowsheet'), 'flowsheet row').id).toBe('trusted-flowsheet');
  });

  it('updates the existing row when name / type / redirectUrls drift from config', async () => {
    // A trustedClient whose redirect URL was changed in .env must be updated
    // in the DB even when the row already exists — otherwise the previous
    // deploy's URL keeps satisfying the FK but is invisible to reviewers who
    // only look at env config.
    const { adapter, calls, rows } = makeFakeAdapter([
      {
        id: 'trusted-flowsheet',
        clientId: 'flowsheet',
        clientSecret: null,
        name: 'Old Name',
        type: 'web',
        disabled: false,
        redirectUrls: 'https://old-host/cb',
        userId: null,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
      },
    ]);

    await bootstrapTrustedClients({ adapter }, [
      flowsheetClient({ name: 'New Name', redirectUrls: ['https://new-host/cb'] }),
    ]);

    expect(calls.findOne).toBe(1);
    expect(calls.create).toBe(0);
    expect(calls.update).toBe(1);

    const row = must(rows.get('flowsheet'), 'flowsheet row');
    expect(row.name).toBe('New Name');
    expect(row.redirectUrls).toBe('https://new-host/cb');
    // Preserved: id, createdAt.
    expect(row.id).toBe('trusted-flowsheet');
    expect(row.createdAt.toISOString()).toBe(new Date('2026-06-01').toISOString());
    // Refreshed: updatedAt.
    expect(row.updatedAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
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

    await bootstrapTrustedClients({ adapter }, [wikijs, flowsheetClient()]);

    expect(calls.create).toBe(2);
    expect(must(rows.get('wiki-id'), 'wiki-id row').id).toBe('trusted-wiki-id');
    expect(must(rows.get('flowsheet'), 'flowsheet row').id).toBe('trusted-flowsheet');
  });

  it('propagates adapter errors so a failed bootstrap fails startup (not silently 500s later)', async () => {
    // The whole point of moving this from a manual SQL insert into a boot
    // hook is to catch the failure before we start accepting traffic. A
    // silent try/catch here would defeat that; the caller in
    // apps/auth/app.ts is the layer that decides fatal-vs-warn.
    const brokenAdapter = {
      findOne(): Promise<never> {
        return Promise.reject(new Error('DB unreachable'));
      },
      create(): Promise<Record<string, never>> {
        return Promise.resolve({});
      },
      update(): Promise<Record<string, never>> {
        return Promise.resolve({});
      },
    };

    await expect(bootstrapTrustedClients({ adapter: brokenAdapter }, [flowsheetClient()])).rejects.toThrow(
      'DB unreachable'
    );
  });
});
