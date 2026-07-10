import * as fs from 'fs';
import * as path from 'path';

// The better-auth `oidcProvider` plugin persists three tables via its
// Drizzle adapter: `oauthApplication`, `oauthAccessToken`, and `oauthConsent`.
// The adapter looks each one up in the `schema: { ... }` map passed to
// `drizzleAdapter(...)`. If any of the three is missing, the adapter throws
// `BetterAuthError: [# Drizzle Adapter]: The model "<name>" was not found in
// the schema object.` at write time — the /auth/oauth2/authorize return trip
// (which writes a consent row) 500s, and OIDC login is broken for every
// downstream client (Wiki.js, flowsheet-digitization verifier). Guard the
// mapping here so the three keys can't silently be dropped again.

// Strip JS comments so a stray `// TODO: restore oauthConsent` inside the
// schema-map block can't satisfy the identifier regex while the real entry
// is gone. Handles both `// line` and `/* block */` forms; the schema map
// is a plain object literal so there are no strings or template literals to
// worry about at this level.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Extract the body of the `drizzleAdapter(db, { ..., schema: { ... } })`
// map. The schema value is a plain literal today; if a future entry
// introduces a nested `{...}` value the non-greedy capture would truncate,
// so we count braces explicitly and slice on the matching close.
function extractSchemaMapBody(source: string): string {
  const anchor = /drizzleAdapter\(db,\s*\{[\s\S]*?schema:\s*\{/g;
  const match = anchor.exec(source);
  if (!match) throw new Error('drizzleAdapter schema map not found in auth.definition.ts');
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error('drizzleAdapter schema map close not found (unbalanced braces)');
}

describe('auth.definition.ts oidcProvider schema wiring', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;
  let sourceNoComments: string;
  let schemaMapBody: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
    sourceNoComments = stripComments(source);
    schemaMapBody = extractSchemaMapBody(sourceNoComments);
  });

  it('imports the three oidcProvider tables from @wxyc/database', () => {
    // Match only the import block itself so a mention in a comment or string
    // elsewhere in the file can't paper over a missing import. TypeScript
    // would catch a bad import at compile time — the assertion here is that
    // the surface a human reads matches the surface the compiler sees.
    const importBlock = sourceNoComments.match(/import\s*\{[^}]*\}\s*from\s*['"]@wxyc\/database['"]/);
    if (!importBlock) throw new Error('@wxyc/database import block not found');
    expect(importBlock[0]).toMatch(/\boauthApplication\b/);
    expect(importBlock[0]).toMatch(/\boauthAccessToken\b/);
    expect(importBlock[0]).toMatch(/\boauthConsent\b/);
  });

  it.each(['oauthApplication', 'oauthAccessToken', 'oauthConsent'])(
    'wires %s into the drizzleAdapter schema map',
    (model) => {
      // The drizzleAdapter schema map is:
      //   drizzleAdapter(db, { provider: 'pg', schema: { ... } })
      // Assert the model key appears as either `key: value` or shorthand
      // `key,`, using an anchor that pins to line start (with leading
      // whitespace) so a substring match inside another identifier — say
      // `_oauthApplication` — can't false-positive.
      const shortForm = new RegExp(`(^|\\n)\\s*${model}\\s*,`);
      const keyValueForm = new RegExp(`(^|\\n)\\s*${model}\\s*:\\s*${model}\\s*,`);
      expect(shortForm.test(schemaMapBody) || keyValueForm.test(schemaMapBody)).toBe(true);
    }
  );
});
