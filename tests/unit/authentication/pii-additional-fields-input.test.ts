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
 * Strip `//` line comments so comment prose (which may contain braces, or the
 * literal text `input: false`) cannot influence brace matching or the
 * assertions. `[^:]` guards the `https://` case — a `//` preceded by a colon
 * is a URL scheme, not a comment.
 */
const stripLineComments = (text: string): string => text.replace(/(^|[^:])\/\/.*$/gm, '$1');

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
  const stripped = stripLineComments(fullSource);
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

const fields = parseFieldEntries(extractAdditionalFieldsBlock(source));
const fieldNames = fields.map((f) => f.name);

describe('auth.definition.ts user.additionalFields input locks', () => {
  // Guards against the parser silently returning nothing and every assertion
  // below passing vacuously — the exact failure mode a source-scanning test
  // must never have.
  it('finds the additionalFields block and parses a plausible number of fields', () => {
    expect(fields.length).toBeGreaterThanOrEqual(8);
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
        expect(body).not.toMatch(/input:\s*false/);
        return;
      }
      expect(body).toMatch(/input:\s*false/);
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
    const unlocked = parsed.filter((f) => !WRITABLE_FIELDS.has(f.name) && !/input:\s*false/.test(f.body));
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
});
