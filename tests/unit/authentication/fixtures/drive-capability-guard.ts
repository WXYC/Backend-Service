/**
 * Driven by capability-assign-plugin.test.ts in a child process (better-auth is ESM-only, so jest cannot
 * load it). Runs the real better-auth router with an in-memory adapter, `admin()`, `bearer()` and the
 * BS#3570 guard, then sends capability writes as a cookie caller and as a bearer caller. argv[2] picks where
 * the guard is registered: `plugin` (the production wiring: the plugin after bearer(), session read through auth.api.getSession) or `legacy` (the user-level
 * hooks.before the first fix used, kept as the control that shows the bypass). The BS#3716 race runs over HTTP
 * through an Express app that mounts the real account-audit middleware and `holdTurnAcross(toNodeHandler(auth))`
 * exactly as apps/auth/app.ts does; `plugin-unqueued` mounts the handler without them, the control that shows the
 * race when nothing serializes the subject. Prints one JSON object.
 */
import { betterAuth } from 'better-auth';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { adminPrefixAuditMiddleware, holdTurnAcross } from '../../../../apps/auth/account-audit-middleware';
import { createAuthJsonBodyParser } from '../../../../apps/auth/json-content-type';
import { capabilityTurn } from '../../../../shared/authentication/src/capability-turn';
import { admin, bearer } from 'better-auth/plugins';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { assertCanAssignCapabilities } from '../../../../shared/authentication/src/capability-assign-guard';
import { capabilityAssignGuardPlugin } from '../../../../shared/authentication/src/capability-assign-plugin';

const mode = process.argv[2];
const BASE = 'http://localhost:8082';
const memberRoles = new Map<string, string>();

// Writes that reach the admin plugin's `updateUser` park here while a gate is armed, so a test can choose the
// order in which two approved writes land.
let gated = false;
const parked: Array<() => void> = [];

const deps = {
  selectMemberRole: (id: string) => {
    const role = memberRoles.get(id);
    return Promise.resolve(role === undefined ? undefined : { role });
  },
  heldTurnSubject: () => capabilityTurn.getStore()?.subjectId,
  readCapabilities: async (id: string) => {
    const found = await (await auth.$context).internalAdapter.findUserById(id);
    return (found as { capabilities?: string[] } | null)?.capabilities ?? [];
  },
};

const auth = betterAuth({
  baseURL: `${BASE}/auth`,
  secret: 'a-test-secret-that-is-long-enough-for-better-auth-1234',
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: false },
  user: { additionalFields: { capabilities: { type: 'string[]', required: false, defaultValue: [], input: false } } },
  databaseHooks: {
    user: {
      update: {
        before: async () => {
          if (gated) {
            await new Promise<void>((resolve) => parked.push(resolve));
          }
        },
      },
    },
  },
  plugins: [admin(), bearer(), ...(mode?.startsWith('plugin') ? [capabilityAssignGuardPlugin(() => auth, deps)] : [])],
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

// Direct handler calls stand in for requests that hold the subject's turn: an update-user runs inside the turn
// context for its `userId`, as `holdTurnAcross` does at the HTTP mount.
const send = (path: string, body: unknown, headers: Record<string, string>) => {
  const subjectId = (body as { userId?: unknown } | null)?.userId;
  const call = () =>
    auth.handler(
      new Request(`${BASE}/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, ...headers },
        body: JSON.stringify(body),
      })
    );
  return path === '/admin/update-user' && typeof subjectId === 'string'
    ? capabilityTurn.run({ subjectId }, call)
    : call();
};

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
// BS#3716: the manager's grant parks at its write, and the director (who may not touch `webmaster`) sends
// `capabilities: []` meanwhile. With nothing serializing the subject, the director's guard reads the pre-grant `[]`,
// finds nothing to refuse, and its write lands after the grant and wipes it. Through the queue the director waits
// for the grant to land, then reads `['webmaster']` and is refused. Requests go over HTTP to an Express app wired
// like apps/auth/app.ts: the same body parser, then the audit mount, then `holdTurnAcross(toNodeHandler(auth))`.
(globalThis as unknown as { __capabilityFixture: unknown }).__capabilityFixture = {
  auth,
  readCapabilities: deps.readCapabilities,
};
const app = express();
app.use(createAuthJsonBodyParser());
if (mode !== 'plugin-unqueued') {
  app.use('/auth/admin', adminPrefixAuditMiddleware());
}
const nodeHandler = toNodeHandler(auth);
// The control runs each request inside a turn context for its `userId` but with no queue behind it, so only the
// serialization is missing.
const unqueuedHandler = (req: express.Request, res: express.Response) =>
  capabilityTurn.run({ subjectId: (req.body as { userId?: string } | undefined)?.userId ?? '' }, () =>
    nodeHandler(req, res)
  );
app.use('/auth', mode === 'plugin-unqueued' ? unqueuedHandler : holdTurnAcross(nodeHandler));
const sendWithoutTurn = (req: express.Request, res: express.Response) => {
  req.url = '/auth/admin/update-user';
  return nodeHandler(req, res);
};
const sendHoldingOtherTurn = (req: express.Request, res: express.Response) => {
  req.url = '/auth/admin/update-user';
  return capabilityTurn.run({ subjectId: 'a-different-subject' }, () => nodeHandler(req, res));
};
app.post('/without-turn/update-user', sendWithoutTurn);
app.post('/other-subject-turn/update-user', sendHoldingOtherTurn);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

/** POSTs over HTTP to the fixture's Express app. */
const rawPost = (path: string, body: unknown, headers: Record<string, string>) =>
  new Promise<{ status: number; code?: string }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          origin: BASE,
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let code: string | undefined;
          try {
            code = (JSON.parse(text) as { code?: string }).code;
          } catch {
            code = undefined;
          }
          resolve({ status: res.statusCode ?? 0, code });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
const sendHttp = (body: unknown, c: { token: string }, path = '/auth/admin/update-user') =>
  rawPost(path, body, { authorization: `Bearer ${c.token}` });

const until = async (done: () => boolean, ms: number) => {
  for (const start = Date.now(); !done() && Date.now() - start < ms;) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** The manager's grant parks at its write; the director's revoke goes out by `path`; then both are released. */
async function race(name: string, path = '/auth/admin/update-user') {
  const racer = await signUp(name, 'dj');
  gated = true;
  const grant = sendHttp({ userId: racer.id, data: { capabilities: ['webmaster'] } }, manager);
  await until(() => parked.length === 1, 2000);
  const revoke = sendHttp({ userId: racer.id, data: { capabilities: [] } }, director, path);
  await until(() => parked.length === 2, 300);
  parked.shift()?.();
  const grantStatus = (await grant).status;
  gated = false;
  parked.splice(0).forEach((release) => release());
  const revoked = await revoke;
  return { grant: grantStatus, revoke: revoked.status, code: revoked.code, stored: await stored(racer.id) };
}

out['race'] = await race('racer');
// Requests that hold no turn for the subject (none at all, or a turn for a different subject) are refused before the
// guard reads or writes. These routes sit outside the audit mount and `holdTurnAcross`.
out['withoutTurn'] = await race('noturn', '/without-turn/update-user');
out['otherSubjectTurn'] = await race('otherturn', '/other-subject-turn/update-user');

// A capabilities write whose userId the queue cannot key on holds no turn, so it is refused before the guard reads or writes.
const unkeyable: Record<string, unknown> = {};
for (const [label, userId] of [
  ['email-shaped', 'victim@test.wxyc.org'],
  ['over 32 characters', 'x'.repeat(33)],
] as const) {
  const res = await sendHttp({ userId, data: { capabilities: ['webmaster'] } }, manager);
  unkeyable[label] = { status: res.status, code: res.code };
}
out['unkeyable'] = unkeyable;

// A direct `auth.api` call has no HTTP mount, so it holds no turn unless the caller runs it inside one.
const apiTarget = await signUp('apitarget', 'dj');
const direct: Record<string, unknown> = {};
for (const [label, inTurn] of [
  ['outside a turn', false],
  ['inside a turn', true],
] as const) {
  const call = () =>
    (
      auth.api as unknown as {
        adminUpdateUser: (input: { body: unknown; headers: Headers }) => Promise<unknown>;
      }
    ).adminUpdateUser({
      body: { userId: apiTarget.id, data: { capabilities: ['webmaster'] } },
      headers: new Headers({ authorization: `Bearer ${manager.token}` }),
    });
  try {
    await (inTurn ? capabilityTurn.run({ subjectId: apiTarget.id }, call) : call());
    direct[label] = { status: 200, stored: await stored(apiTarget.id) };
  } catch (error) {
    const e = error as { statusCode?: number; body?: { code?: string } };
    direct[label] = { status: e.statusCode, code: e.body?.code, stored: await stored(apiTarget.id) };
  }
  await (await auth.$context).internalAdapter.updateUser(apiTarget.id, { capabilities: [] });
}
out['direct'] = direct;
server.close();
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
