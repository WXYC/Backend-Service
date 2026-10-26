import { AsyncLocalStorage } from 'node:async_hooks';

/** The subject whose per-subject turn the current request holds. */
export interface CapabilityTurnContext {
  subjectId: string;
}

/**
 * Which subject's turn the running request holds, if any. `holdTurnAcross` (apps/auth/account-audit-middleware.ts)
 * runs the better-auth handler inside `capabilityTurn.run({ subjectId }, ...)` for a request that holds a turn;
 * the capability-assign guard reads it with `heldCapabilityTurnSubject()` and refuses a capabilities write to a
 * subject whose turn the request does not hold. The guard only reads: it never takes a turn.
 *
 * Kept on `globalThis` so that a second copy of this module (the app bundle and a workspace package's own build)
 * shares the one store.
 */
const KEY = Symbol.for('wxyc.capabilityTurn');
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<CapabilityTurnContext> | undefined>;
export const capabilityTurn: AsyncLocalStorage<CapabilityTurnContext> = (holder[KEY] ??=
  new AsyncLocalStorage<CapabilityTurnContext>());

/** The subject id the current async context holds the turn for, or `undefined` outside a turn. */
export const heldCapabilityTurnSubject = (): string | undefined => capabilityTurn.getStore()?.subjectId;
