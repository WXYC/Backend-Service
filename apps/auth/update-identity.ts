/**
 * Self-service edits to the signed-in DJ's own `realName` / `djName`.
 *
 * WHY THIS ENDPOINT EXISTS. BS#2297 locked both fields to `input: false` in
 * `auth.definition.ts`'s `user.additionalFields`, which closes better-auth's
 * public `POST /update-user` to them: `parseInputData`
 * (better-auth/dist/db/schema.mjs) throws `<field> is not allowed to be set`
 * for any `input: false` field carrying a truthy value. That lock enumerated
 * the writers it had verified — dj-site's admin roster path
 * (`authClient.admin.updateUser`, which bypasses `parseUserInput` entirely),
 * plus provisioning and onboarding (both direct `internalAdapter` calls) —
 * and missed a third: a DJ editing their own profile in dj-site's "Your
 * Information" modal, whose only write path was the now-closed public route.
 * From the lock landing (2026-08-28) until this endpoint, no DJ could change
 * their own on-air handle; the modal returned a 400 naming whichever of the
 * two fields they had edited.
 *
 * The lock is not the thing to relax. Widening `WRITABLE_FIELDS` in
 * `tests/unit/authentication/pii-additional-fields-input.test.ts` would
 * reopen `/update-user` as a general write path for the PII name pair; this
 * route instead narrows the opening to exactly the case that is legitimate —
 * an authenticated user, their own row, two fields, nothing else.
 *
 * TWO PROPERTIES DO THE SECURITY WORK, and both are load-bearing:
 *
 *   1. **The subject comes from the session, never the body.** There is no
 *      `userId` parameter. Editing someone else's identity is the admin
 *      plugin's job (`authClient.admin.updateUser`), which has its own
 *      role gate.
 *   2. **An allowlist is forwarded, never the body.** `buildUpdate` copies
 *      at most two keys into a fresh object. Spreading the request body here
 *      would hand back every hole the `input: false` lock closed — worse,
 *      on a route that bypasses `parseUserInput` and so has no second line
 *      of defence. `capabilities` (the JWT/OIDC privilege claim), `role`,
 *      `emailVerified` and the self-signup review columns all live on the
 *      same row.
 *
 * `internalAdapter.updateUser` still runs `databaseHooks.user.update.before`
 * — `deriveOrRejectUserNameOnUpdate` — so `auth_user.name` is re-derived
 * from the new handle at its single choke point exactly as it is for
 * onboarding and provisioning. This route deliberately does NOT send a
 * `name` key; the hook derives it.
 */

import { auth, deriveStationSignupIpHash } from '@wxyc/authentication';
import { recordAccountAuditEvent } from '@wxyc/database';
import { onAccountAuditError } from './account-audit-error.js';

export class UpdateIdentityError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'UpdateIdentityError';
  }
}

export interface UpdateIdentityResult {
  status: true;
  userId: string;
  realName?: string;
  djName?: string;
}

/** Both columns are `varchar(255)` (`schema.ts` `auth_user`). */
const MAX_IDENTITY_FIELD_LENGTH = 255;

/**
 * The fields a DJ may set on themselves. Adding to this list is a deliberate,
 * reviewable edit — the same posture as `WRITABLE_FIELDS` in
 * `tests/unit/authentication/pii-additional-fields-input.test.ts`.
 */
const EDITABLE_FIELDS = ['realName', 'djName'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Parse one optional field. Absent is fine; present-but-unusable is an error
 * rather than a silent drop — a client that believes it saved a name must
 * never be told it succeeded.
 *
 * Blank is rejected instead of clearing: these are the two identity fields
 * dj-site marks non-clearable, and `resolveDjDisplayName` reads a blank
 * handle as "no handle", which would leave the public on-air name stale
 * rather than empty.
 */
function parseField(raw: unknown, field: EditableField): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new UpdateIdentityError(400, `${field} must be a string`, 'INVALID_REQUEST');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UpdateIdentityError(400, `${field} cannot be empty`, 'INVALID_REQUEST');
  }
  if (trimmed.length > MAX_IDENTITY_FIELD_LENGTH) {
    throw new UpdateIdentityError(
      400,
      `${field} must be ${MAX_IDENTITY_FIELD_LENGTH} characters or fewer`,
      'INVALID_REQUEST'
    );
  }
  return trimmed;
}

/**
 * `resolveDjDisplayName` treats the literal "Anonymous" as unusable, so
 * accepting one here would write `dj_name = 'Anonymous'` while
 * `deriveOrRejectUserNameOnUpdate` left `auth_user.name` at its prior value
 * — the split state behind the 2026-06-02 on-air incident (BS#1286, epic
 * #1288). Refuse it at the door, with a message that says why, rather than
 * saving a handle that will never render.
 */
function assertUsableHandle(djName: string): void {
  if (djName.toLowerCase() === 'anonymous') {
    throw new UpdateIdentityError(400, '"Anonymous" is reserved and cannot be used as a DJ name', 'INVALID_DJ_NAME');
  }
}

function buildUpdate(body: Record<string, unknown>): Partial<Record<EditableField, string>> {
  const update: Partial<Record<EditableField, string>> = {};

  for (const field of EDITABLE_FIELDS) {
    const value = parseField(body[field], field);
    if (value !== undefined) update[field] = value;
  }

  if (update.djName !== undefined) assertUsableHandle(update.djName);

  if (Object.keys(update).length === 0) {
    throw new UpdateIdentityError(400, 'Supply at least one of realName or djName', 'INVALID_REQUEST');
  }

  return update;
}

async function resolveIdentityUpdate(body: Record<string, unknown>, headers: Headers): Promise<UpdateIdentityResult> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    throw new UpdateIdentityError(401, 'Sign in to update your profile', 'UNAUTHORIZED');
  }
  if ((session.user as { isAnonymous?: boolean }).isAnonymous) {
    throw new UpdateIdentityError(403, 'Anonymous sessions cannot update a profile', 'FORBIDDEN');
  }

  // Shape is validated AFTER the session so an unauthenticated prober learns
  // nothing about the accepted body from the error it gets back.
  const update = buildUpdate(body);

  const context = await auth.$context;
  await context.internalAdapter.updateUser(session.user.id, update);

  return { status: true, userId: session.user.id, ...update };
}

/**
 * Audited entry point. Mirrors `completeOnboardingFromRequest`: one `audit`
 * partial application fixes action/ipHash/source, and the error is narrowed
 * once.
 *
 * Unlike onboarding, this route always has a session, so the actor is known
 * — and actor and subject are necessarily the same row (property 1 in the
 * module docblock). Both are recorded so a reader of `account_audit_event`
 * can tell a self-service edit from the admin roster path without joining
 * anything. Only ids are recorded: the values being written are the PII name
 * pair, and `account_audit_event` has no column for a value.
 */
export async function updateIdentityFromRequest(
  body: Record<string, unknown>,
  headers: Headers
): Promise<UpdateIdentityResult> {
  const ipHash = deriveStationSignupIpHash(headers.get('x-real-ip') ?? undefined);
  const audit = (fields: {
    actorUserId?: string;
    subjectUserId?: string;
    outcome: number;
    errorCode?: string | null;
  }): void => {
    void recordAccountAuditEvent(
      { action: 'wxyc.update-identity', ipHash, source: 'http', ...fields },
      { onError: onAccountAuditError }
    );
  };

  try {
    const result = await resolveIdentityUpdate(body, headers);
    audit({ actorUserId: result.userId, subjectUserId: result.userId, outcome: 200 });
    return result;
  } catch (error) {
    const known = error instanceof UpdateIdentityError ? error : null;
    audit({ outcome: known?.statusCode ?? 500, errorCode: known?.code ?? null });
    throw error;
  }
}
