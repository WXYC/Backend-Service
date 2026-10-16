import * as fs from 'fs';
import * as path from 'path';

// FINDING 3 (BS#2297 review): auth.definition.ts's user.additionalFields
// defaulted realName/djName to input:true, so better-auth's public
// POST /update-user let any signed-in session rewrite them directly. Full
// writeup — the two-writers verification, and why this lock is complementary
// to (not redundant with) the databaseHooks.user veto — lives once, at the
// additionalFields.realName/djName site in auth.definition.ts.
//
// BS#2358 inverted this file from an allowlist to a DENYLIST. It used to name
// six fields and assert input:false on each, which structurally could not
// catch the failure it exists to prevent: a field nobody remembers to add to
// the list. That is not hypothetical — `hasCompletedOnboarding` sat unlocked
// from the day it was registered, and `capabilities` (the JWT/OIDC privilege
// claim, docs/authentication.md) sat unlocked right through the first draft of
// the very PR that closed hasCompletedOnboarding. Both were invisible to a
// hand-maintained list.
//
// So: enumerate EVERY field in the additionalFields block and require
// input:false on each, with a short, justified allowlist of the ones a signed-
// in user is genuinely allowed to write about themselves. Adding a new field
// without the flag fails here by default. Widening WRITABLE_FIELDS is a
// deliberate, reviewable edit — that is the whole point.
//
// The block is located by brace-matching from `additionalFields: {` rather
// than by a bare `source.match(/<field>: \{...\}/)`, which returned the FIRST
// match anywhere in the file — a braced example inside an unrelated comment
// could satisfy it, and a field declared outside the block would be checked as
// if it were inside one.

const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = fs.readFileSync(authDefPath, 'utf-8');

/**
 * Fields a signed-in user may legitimately set on themselves through
 * better-auth's public POST /update-user. Every entry needs a reason; anything
 * absent from this map must carry `input: false`.
 */
const WRITABLE_FIELDS = new Map<string, string>([
  [
    'appSkin',
    // A per-user UI preference with no authority, no PII, and no downstream
    // claim. It is the one additionalField the app deliberately exposes to
    // self-service: derive-user-display-name.ts records the
    // `updateUser({ appSkin })` experience switch as a first-class caller of
    // the public route.
    'user-chosen UI experience switch — carries no authority, no PII, and no JWT/OIDC claim',
  ],
]);

/**
 * Strip comments so comment prose — which may contain braces, or the literal
 * text `input: false` — cannot influence brace matching or the assertions.
 *
 * BOTH comment forms, and that is not cosmetic. A `//`-only stripper leaves
 * `/* input: false *\/` inside an otherwise-unlocked field body satisfying the
 * lock assertion, which silently disarms the one guard standing between a new
 * additionalField and better-auth's public POST /update-user. A regex pair
 * cannot do this safely either: `auth.definition.ts` contains `https://…` and
 * `/auth/*` inside `//` comments, so a block-comment regex run first would
 * open a "comment" at the `/*` in `//*` and swallow everything up to the next
 * `*\/` anywhere in the file, while running it second leaves `/*` fragments
 * behind after the line stripper has eaten the closing half. One left-to-right
 * pass is the only ordering-free answer.
 *
 * String literals are copied verbatim for the same reason — a `//` or `/*`
 * inside a quoted default value is data, not a comment. Block comments are
 * replaced by a space rather than removed outright so a comment wedged
 * mid-identifier cannot fuse two tokens into a third.
 */
const stripComments = (text: string): string => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    if (pair === '/*') {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (pair === '//') {
      const end = text.indexOf('\n', i);
      // Stop AT the newline, never past it, so line structure survives.
      i = end === -1 ? text.length : end;
      continue;
    }
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
};

/** Index of the `}` that closes the `{` at `openIndex`. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unbalanced braces while scanning auth.definition.ts');
}

/** The body of `user.additionalFields`, comments removed. */
function extractAdditionalFieldsBlock(fullSource: string): string {
  const stripped = stripComments(fullSource);
  const marker = /additionalFields\s*:\s*\{/.exec(stripped);
  if (marker === null) {
    throw new Error('user.additionalFields block not found in auth.definition.ts');
  }
  const openIndex = marker.index + marker[0].length - 1;
  return stripped.slice(openIndex + 1, findMatchingBrace(stripped, openIndex));
}

/** Every `name: { ... }` entry declared directly in the block. */
function parseFieldEntries(block: string): { name: string; body: string }[] {
  const entries: { name: string; body: string }[] = [];
  const keyPattern = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  // Advancing lastIndex past each entry's closing brace is what keeps this at
  // the block's top level: a nested `key: {` inside a field's body is skipped
  // over rather than mistaken for a field of its own.
  while ((match = keyPattern.exec(block)) !== null) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(block, openIndex);
    entries.push({ name: match[1], body: block.slice(openIndex + 1, closeIndex) });
    keyPattern.lastIndex = closeIndex + 1;
  }
  return entries;
}

/**
 * The properties declared directly on a field's body, as `key -> value text`.
 *
 * `input` is what better-auth's `parseInputData` reads (`fields[key].input`),
 * so the lock has to be asserted against the field's OWN `input` property.
 * Matching `input: false` as a substring of the whole body is satisfied by
 * `validator: { input: false }`, `transform: { input: false }`,
 * `label: 'input: false'` and a regex literal `/input: false/` -- none of which
 * lock anything. Splitting on depth-0 commas (outside strings) leaves only the
 * field's own keys; nested objects, arrays and strings stay inside one value.
 * A later duplicate key wins, as it does in the object literal itself.
 */
function topLevelProperties(body: string): Map<string, string> {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < body.length && body[i] !== ch) {
        i += body[i] === '\\' ? 2 : 1;
      }
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(body.slice(start));

  const props = new Map<string, string>();
  for (const segment of segments) {
    const m = /^\s*(['"]?)([A-Za-z_$][A-Za-z0-9_$]*)\1\s*:\s*([\s\S]*?)\s*$/.exec(segment);
    if (m !== null) {
      props.set(m[2], m[3]);
    }
  }
  return props;
}

const hasOwnFlag = (body: string, key: 'input' | 'returned'): boolean => topLevelProperties(body).get(key) === 'false';

const fields = parseFieldEntries(extractAdditionalFieldsBlock(source));
const fieldNames = fields.map((f) => f.name);

describe('auth.definition.ts user.additionalFields input locks', () => {
  // Guards against the parser silently returning nothing and every assertion
  // below passing vacuously — the exact failure mode a source-scanning test
  // must never have.
  it('finds the additionalFields block and parses every declared field', () => {
    // Exact, not a floor: a `>=` count leaves slack, so one silently dropped
    // field would not trip it. Adding a field means bumping this on purpose.
    expect(fields).toHaveLength(10);
    // Spot-check both ends of the block so a truncated match is caught.
    expect(fieldNames).toContain('realName');
    expect(fieldNames).toContain('capabilities');
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
  });

  it.each(fields.map((f): [string, string] => [f.name, f.body]))(
    'locks %s to input: false so the public /update-user route cannot write it directly',
    (name, body) => {
      if (WRITABLE_FIELDS.has(name)) {
        // Documented as user-writable. Assert the opposite so the two halves of
        // this file can't drift into agreeing by accident.
        expect(hasOwnFlag(body, 'input')).toBe(false);
        return;
      }
      expect(hasOwnFlag(body, 'input')).toBe(true);
    }
  );

  it('has no stale entries in WRITABLE_FIELDS', () => {
    for (const name of WRITABLE_FIELDS.keys()) {
      expect(fieldNames).toContain(name);
    }
  });
});

// The deny-by-default property is the whole point of the rewrite, so prove it
// on synthetic sources rather than trusting that the real file happens to be
// clean today.
describe('additionalFields scanner', () => {
  const wrap = (inner: string) => `betterAuth({ user: { additionalFields: {\n${inner}\n} } });`;

  it('reports a newly added field that lacks input: false', () => {
    const block = extractAdditionalFieldsBlock(
      wrap(`      realName: { type: 'string', required: false, input: false },
      brandNewPrivilege: { type: 'string[]', required: false, defaultValue: [] },`)
    );
    const parsed = parseFieldEntries(block);
    expect(parsed.map((f) => f.name)).toEqual(['realName', 'brandNewPrivilege']);
    const unlocked = parsed.filter((f) => !WRITABLE_FIELDS.has(f.name) && !hasOwnFlag(f.body, 'input'));
    expect(unlocked.map((f) => f.name)).toEqual(['brandNewPrivilege']);
  });

  it('ignores a braced example inside a comment', () => {
    const block = extractAdditionalFieldsBlock(
      wrap(`      // Counter-example: notAField: { type: 'string' } must not be picked up.
      realName: { type: 'string', required: false, input: false },`)
    );
    expect(parseFieldEntries(block).map((f) => f.name)).toEqual(['realName']);
  });

  it('does not treat a nested object as a top-level field', () => {
    const block = extractAdditionalFieldsBlock(
      wrap(`      realName: { type: 'string', input: false, transform: { input: (v) => v } },
      djName: { type: 'string', input: false },`)
    );
    expect(parseFieldEntries(block).map((f) => f.name)).toEqual(['realName', 'djName']);
  });

  // The regression that motivated stripComments. A `//`-only stripper left this
  // field reading as locked while `parseUserInput` still accepted writes to it,
  // so the guard reported green on precisely the hole it exists to close.
  it('does not let a block comment inside a field body satisfy the lock', () => {
    const block = extractAdditionalFieldsBlock(
      wrap(`      realName: { type: 'string', required: false, input: false },
      capabilities: { type: 'string[]', required: false, defaultValue: [] /* input: false */ },`)
    );
    const parsed = parseFieldEntries(block);
    expect(parsed.map((f) => f.name)).toEqual(['realName', 'capabilities']);
    const unlocked = parsed.filter((f) => !WRITABLE_FIELDS.has(f.name) && !hasOwnFlag(f.body, 'input'));
    expect(unlocked.map((f) => f.name)).toEqual(['capabilities']);
  });

  it('ignores a braced example inside a block comment', () => {
    const block = extractAdditionalFieldsBlock(
      wrap(`      /* Counter-example: notAField: { type: 'string' } must not be picked up. */
      realName: { type: 'string', required: false, input: false },`)
    );
    expect(parseFieldEntries(block).map((f) => f.name)).toEqual(['realName']);
  });

  it('does not let a block comment fuse two identifiers into a third', () => {
    // `inp/**/ut: false` must not survive as the literal text `input: false`.
    const block = extractAdditionalFieldsBlock(
      wrap(`      sneaky: { type: 'string', required: false, inp/**/ut: false },`)
    );
    const parsed = parseFieldEntries(block);
    expect(parsed).toHaveLength(1);
    expect(hasOwnFlag(parsed[0].body, 'input')).toBe(false);
  });

  it('treats comment markers inside string literals as data, not comments', () => {
    // A quoted default value carrying `//` or `/*` must not truncate the scan.
    const block = extractAdditionalFieldsBlock(
      wrap(`      homepage: { type: 'string', defaultValue: 'https://wxyc.org/*', input: false },
      djName: { type: 'string', input: false },`)
    );
    const parsed = parseFieldEntries(block);
    expect(parsed.map((f) => f.name)).toEqual(['homepage', 'djName']);
    for (const field of parsed) expect(hasOwnFlag(field.body, 'input')).toBe(true);
  });

  // `input: false` must be the field's own literal property. Each body below
  // renders the substring somewhere else; for all but the spread case,
  // parseInputData -- which reads only `fields[key].input` -- would still
  // accept writes. The spread does lock the field at runtime, but the scanner
  // cannot see through it, so it fails closed on that case too.
  it.each([
    ['a nested validator object', `{ type: 'string[]', validator: { input: false } }`],
    ['a nested transform object', `{ type: 'string', transform: { input: false } }`],
    ['a string label', `{ type: 'string', label: 'input: false' }`],
    ['a regex literal', `{ type: 'string', pattern: /input: false/ }`],
    ['a template literal', "{ type: 'string', label: `input: false` }"],
    ['a later duplicate key', `{ type: 'string', input: false, input: true }`],
    ['a spread', `{ type: 'string', ...{ input: false } }`],
  ])('does not count %s as a lock', (_label, fieldSource) => {
    const [field] = parseFieldEntries(extractAdditionalFieldsBlock(wrap(`      sneaky: ${fieldSource},`)));
    expect(field.name).toBe('sneaky');
    expect(hasOwnFlag(field.body, 'input')).toBe(false);
  });

  it.each([
    [`{ type: 'string', input: false }`],
    [`{ type: 'string', 'input': false }`],
    [`{ type: 'string[]', defaultValue: [], validator: { input: true }, input: false }`],
  ])('counts a field whose own input is false as locked: %s', (fieldSource) => {
    const [field] = parseFieldEntries(extractAdditionalFieldsBlock(wrap(`      locked: ${fieldSource},`)));
    expect(hasOwnFlag(field.body, 'input')).toBe(true);
  });
});

// The output side. `input` and `returned` are independent attributes on the
// same declaration — `parseUserInput` filters on the first, `parseUserOutput`
// (better-auth/dist/db/schema.mjs) on the second — so a field can be
// unwritable and still ride every /get-session body and JWT payload. The OIDC
// claim is a separate surface: buildOidcUserInfoClaim emits only an explicit
// allowlist ({ role, capabilities }) from the raw user row, whatever a
// field's flags say. This is a single-field pin rather than a second
// deny-by-default sweep: most additionalFields are *supposed* to be returned (dj-site's roster
// and the JWT `capabilities` claim both depend on it), so a blanket rule here
// would be wrong in the common case. Only the field naming a third party gets
// the flag.
describe('auth.definition.ts user.additionalFields output locks', () => {
  const bodyOf = (name: string): string => {
    const field = fields.find((f) => f.name === name);
    if (field === undefined) throw new Error(`Field ${name} not found in additionalFields`);
    return field.body;
  };

  it('keeps selfSignupReviewedBy off /get-session, the JWT, and /admin/list-users', () => {
    // It holds the reviewing manager's auth_user.id — another person's
    // identifier on the reviewed DJ's own row. buildJwtPayload spreads the
    // whole user object, so these surfaces rely on `returned: false` having
    // stripped the field first. The OIDC claim is NOT covered by this flag:
    // better-auth hands getAdditionalUserInfoClaim the raw adapter row, so it
    // is protected by buildOidcUserInfoClaim's explicit allowlist, pinned in
    // jwt-payload.test.ts.
    expect(hasOwnFlag(bodyOf('selfSignupReviewedBy'), 'returned')).toBe(true);
  });

  it.each(['selfSignupAt', 'selfSignupReviewedAt', 'selfSignupDowngradedAt'])(
    'leaves %s returned, because the roster review queue reads it from admin/list-users',
    (name) => {
      // `returned` is global, not audience-scoped: the admin plugin's roster
      // route maps every row through the same parseUserOutput. dj-site's
      // pending-review predicate is `self_signup_at IS NOT NULL AND
      // self_signup_reviewed_at IS NULL`, so hiding either field pins it to a
      // constant — a queue that never empties, or one that is never populated —
      // with nothing going red. selfSignupDowngradedAt (BS#2364) is the same
      // trade one step further on: hidden, a manager looking at a `member`-role
      // account in the review queue cannot tell one this job auto-downgraded
      // from one that was always a member, and BS#2362's approve endpoint
      // cannot preserve it as history. All three are timestamps on the account
      // holder's own row and name no third party -- the downgrade's actor is a
      // cron job, not a person.
      expect(hasOwnFlag(bodyOf(name), 'returned')).toBe(false);
    }
  );
});
