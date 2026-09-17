/**
 * Unit tests for apps/auth/json-content-type.ts (BS#2558): the pure predicate
 * `express.json({ type: ... })` uses to decide whether to parse a request
 * body as JSON, widened to match better-call's own JSON-parsing gate.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { BETTER_CALL_JSON_CONTENT_TYPE, isBetterCallJsonRequest } from '../../../apps/auth/json-content-type';

/**
 * better-call does not export `dist/utils.mjs` from its `package.json`
 * "exports" map (only `.`, `./client`, `./error`, `./node`), so the regex it
 * defines there (`jsonContentTypeRegex`) can't be `import`ed directly to
 * compare against. Read the compiled file straight off disk instead —
 * `fs.readFileSync` never consults the exports map, it's a plain filesystem
 * read against a path computed from the package's own `.` entry point — and
 * assert our copy's `.source` text is still literally present in it. This is
 * a drift detector, not a correctness proof: if a future `better-call` bump
 * changes that regex, this fails loudly instead of the two parsers silently
 * disagreeing again the way they did before BS#2558.
 */
function betterCallUtilsSource(): string {
  const entryPoint = require.resolve('better-call'); // resolves via the "." export, e.g. .../better-call/dist/index.cjs
  return readFileSync(path.join(path.dirname(entryPoint), 'utils.mjs'), 'utf8');
}

describe('BETTER_CALL_JSON_CONTENT_TYPE', () => {
  it("stays byte-identical to the installed better-call package's own jsonContentTypeRegex", () => {
    expect(betterCallUtilsSource()).toContain(BETTER_CALL_JSON_CONTENT_TYPE.source);
  });
});

function mockReq(contentType: string | undefined): { headers: Record<string, string | undefined> } {
  return { headers: { 'content-type': contentType } };
}

describe('isBetterCallJsonRequest', () => {
  describe('content types better-call parses as JSON (must be accepted — the BS#2558 gap)', () => {
    it.each([
      'application/json',
      'application/jsonx',
      'application/json-patch+json',
      'application/json5',
      'application/vnd.api+json',
      'APPLICATION/JSON',
      'Application/Json-Patch+Json',
      'application/json; charset=utf-8',
    ])('accepts %s', (contentType) => {
      expect(isBetterCallJsonRequest(mockReq(contentType) as never)).toBe(true);
    });
  });

  describe('content types better-call does NOT parse as JSON (must stay rejected — the "no widening past better-call" bar)', () => {
    it.each([
      'text/plain',
      'application/xml',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/json', // does not start with "application/" — outside better-call's surface even though it names json
      undefined,
      '',
    ])('rejects %p', (contentType) => {
      expect(isBetterCallJsonRequest(mockReq(contentType) as never)).toBe(false);
    });
  });

  it('agrees with BETTER_CALL_JSON_CONTENT_TYPE.test() on every sampled content type', () => {
    const sampled = [
      'application/json',
      'application/jsonx',
      'application/json-patch+json',
      'application/json5',
      'application/vnd.api+json',
      'application/hal+json',
      'application/ld+json',
      'text/plain',
      'text/html',
      'application/xml',
      'application/octet-stream',
      'application/pdf',
      'image/png',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      '',
    ];
    for (const contentType of sampled) {
      expect(isBetterCallJsonRequest(mockReq(contentType) as never)).toBe(
        BETTER_CALL_JSON_CONTENT_TYPE.test(contentType)
      );
    }
  });
});
