import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import {
  CAPABILITY_WRITE_PATHS,
  assertCanAssignCapabilities,
  type CapabilityAssignDeps,
} from './capability-assign-guard';

const isCapabilityWrite = (path: string | undefined): boolean =>
  (CAPABILITY_WRITE_PATHS as readonly string[]).includes(path ?? '');

/** The slice of the `betterAuth()` instance the guard needs: the full `getSession` pipeline, hooks included. */
export interface SessionApi {
  api: {
    getSession: (input: { headers: Headers }) => Promise<{
      user?: { id: string; capabilities?: string[] | null } | null;
    } | null>;
  };
}

/**
 * The BS#3570 capability-assigner check as an inline better-auth plugin.
 *
 * The check has to see the caller the admin plugin will act as. A bearer caller sends no cookie:
 * `bearer()`'s before-hook builds the session cookie, but better-auth applies the headers a before-hook
 * returns only after EVERY before-hook has run (dispatch.mjs `runBeforeHooks`). So `getSessionFromCtx`
 * returns null in any before-hook, whether it is the user-level one or a plugin listed after `bearer()`
 * (pinned by capability-assign-plugin.test.ts). This hook therefore resolves the session through
 * `auth.api.getSession`, which runs the whole pipeline (bearer conversion included) exactly as the admin
 * plugin's own session read does. `getAuth` is a thunk because the plugin is built while `auth` is still
 * being defined. If no session resolves the guard refuses (401), see `assertCanAssignCapabilities`.
 */
export function capabilityAssignGuardPlugin(getAuth: () => SessionApi, deps: CapabilityAssignDeps): BetterAuthPlugin {
  return {
    id: 'capability-assign-guard',
    hooks: {
      before: [
        {
          matcher: (ctx) => isCapabilityWrite(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.request?.headers ?? ctx.headers ?? new Headers();
            const session = await getAuth().api.getSession({ headers });
            const actor = session?.user ? { id: session.user.id, capabilities: session.user.capabilities } : null;
            await assertCanAssignCapabilities(ctx.path, ctx.body, actor, deps);
          }),
        },
      ],
    },
  };
}
