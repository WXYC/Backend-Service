/**
 * Driven by capability-assign-plugin.test.ts in a child process (better-auth is ESM-only, so jest cannot
 * load it). Runs the real better-auth router with an in-memory adapter, `admin()`, `bearer()` and the
 * BS#3570 guard, then sends capability writes as a cookie caller and as a bearer caller. argv[2] picks where
 * the guard is registered: `plugin` (the production wiring: the plugin after bearer(), session read through auth.api.getSession) or `legacy` (the user-level
 * hooks.before the first fix used, kept as the control that shows the bypass). Prints one JSON object.
 */
import { betterAuth } from 'better-auth';
import { admin, bearer } from 'better-auth/plugins';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { assertCanAssignCapabilities } from '../../../../shared/authentication/src/capability-assign-guard';
import { capabilityAssignGuardPlugin } from '../../../../shared/authentication/src/capability-assign-plugin';

const mode = process.argv[2];
const BASE = 'http://localhost:8082';
const memberRoles = new Map<string, string>();

const deps = {
  selectMemberRole: (id: string) => {
    const role = memberRoles.get(id);
    return Promise.resolve(role === undefined ? undefined : { role });
  },
  readCapabilities: async (id: string) => {
    const found = await (await auth.$context).internalAdapter.findUserById(id);
    return (found as { capabilities?: string[] } | null)?.capabilities ?? [];
  },
};

const auth = betterAuth({
  baseURL: BASE,
  secret: 'a-test-secret-that-is-long-enough-for-better-auth-1234',
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: false },
  user: { additionalFields: { capabilities: { type: 'string[]', required: false, defaultValue: [], input: false } } },
  plugins: [admin(), bearer(), ...(mode === 'plugin' ? [capabilityAssignGuardPlugin(() => auth, deps)] : [])],
  hooks:
    mode === 'legacy'
      ? {
          before: createAuthMiddleware(async (ctx) => {
            if (ctx.path !== '/admin/update-user' && ctx.path !== '/admin/create-user') {
              return;
            }
            const session = await getSessionFromCtx(ctx);
            const actor = session?.user ? { id: session.user.id, capabilities: [] } : null;
            if (actor || (ctx.body as { data?: { capabilities?: unknown } })?.data?.capabilities === undefined) {
              await assertCanAssignCapabilities(ctx.path, ctx.body, actor, deps);
            }
          }),
        }
      : undefined,
});

const send = (path: string, body: unknown, headers: Record<string, string>) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...headers },
      body: JSON.stringify(body),
    })
  );

async function signUp(name: string, memberRole: string) {
  const email = `${name}@test.wxyc.org`;
  const res = await send('/sign-up/email', { email, password: 'testpassword123', name }, {});
  const id = ((await res.json()) as { user: { id: string } }).user.id;
  // Both callers carry the global admin flag so only the assigner check can refuse them.
  await (await auth.$context).internalAdapter.updateUser(id, { role: 'admin' });
  memberRoles.set(id, memberRole);
  const signIn = await send('/sign-in/email', { email, password: 'testpassword123' }, {});
  const token = signIn.headers.get('set-auth-token') as string;
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0] as string;
  return { id, token, cookie };
}

const manager = await signUp('manager', 'stationManager');
const director = await signUp('director', 'musicDirector');
const victim = await signUp('victim', 'dj');

const stored = async (id: string) => (await deps.readCapabilities(id)).slice().sort();
const out: Record<string, unknown> = {};

for (const [label, caller] of [
  ['manager', manager],
  ['director', director],
] as const) {
  for (const via of ['cookie', 'bearer'] as const) {
    const headers: Record<string, string> =
      via === 'bearer' ? { authorization: `Bearer ${caller.token}` } : { cookie: caller.cookie };
    const update = await send(
      '/admin/update-user',
      { userId: victim.id, data: { capabilities: ['webmaster'] } },
      headers
    );
    const updated = await stored(victim.id);
    await (await auth.$context).internalAdapter.updateUser(victim.id, { capabilities: [] });
    const create = await send(
      '/admin/create-user',
      {
        email: `c-${label}-${via}@test.wxyc.org`,
        password: 'testpassword123',
        name: 'C',
        role: 'user',
        data: { capabilities: ['editor'] },
      },
      headers
    );
    const createdBody = create.ok ? ((await create.json()) as { user: { id: string } }) : null;
    out[`${label}.${via}`] = {
      update: update.status,
      updateStored: updated,
      create: create.status,
      createStored: createdBody ? await stored(createdBody.user.id) : null,
    };
  }
}
const anon = await send('/admin/update-user', { userId: victim.id, data: { capabilities: ['webmaster'] } }, {});
out['anonymous'] = { update: anon.status, updateStored: await stored(victim.id) };
console.log(`RESULT ${JSON.stringify(out)}`);
