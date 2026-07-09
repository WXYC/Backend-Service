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

describe('auth.definition.ts oidcProvider schema wiring', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
  });

  it('imports the three oidcProvider tables from @wxyc/database', () => {
    // The drizzleAdapter schema map references these three tables by their
    // module-level export names. If they aren't imported, TypeScript would
    // catch it — but the map is a `key: value` literal, so a shorthand
    // `oauthConsent,` still requires the import to exist. Assert both the
    // import line and the map entry so a missing-import regression is
    // localized.
    expect(source).toMatch(/oauthApplication[,\s]/);
    expect(source).toMatch(/oauthAccessToken[,\s]/);
    expect(source).toMatch(/oauthConsent[,\s]/);
  });

  it.each(['oauthApplication', 'oauthAccessToken', 'oauthConsent'])(
    'wires %s into the drizzleAdapter schema map',
    (model) => {
      // The drizzleAdapter schema map is:
      //   drizzleAdapter(db, { provider: 'pg', schema: { ... } })
      // Assert the model key appears inside that map, tolerant of either the
      // `key: value` or shorthand `key` forms.
      const schemaBlock = source.match(/drizzleAdapter\(db,\s*\{[\s\S]*?schema:\s*\{([\s\S]*?)\}\s*,?\s*\}\)/);
      if (!schemaBlock) {
        throw new Error('drizzleAdapter schema map not found in auth.definition.ts');
      }
      const body = schemaBlock[1];
      const shortForm = new RegExp(`\\b${model}\\b\\s*,`);
      const keyValueForm = new RegExp(`\\b${model}\\s*:\\s*${model}\\b`);
      expect(shortForm.test(body) || keyValueForm.test(body)).toBe(true);
    }
  );
});
