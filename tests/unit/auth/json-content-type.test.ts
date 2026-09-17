/**
 * Unit tests for apps/auth/json-content-type.ts (BS#2558): the pure predicate
 * `express.json({ type: ... })` uses to decide whether to parse a request
 * body as JSON, widened to match better-call's own JSON-parsing gate.
 */
import path from 'path';
import { BETTER_CALL_JSON_CONTENT_TYPE, isBetterCallJsonRequest } from '../../../apps/auth/json-content-type';
import { resolveNestedBetterCall } from '../../utils/resolve-nested-better-call';

function mockReq(contentType: string | undefined): { headers: Record<string, string | undefined> } {
  return { headers: { 'content-type': contentType } };
}

/**
 * Behavioral drift detector for `BETTER_CALL_JSON_CONTENT_TYPE` (BS#2558 PR
 * #2566 review Finding 3), replacing an earlier version of this test that
 * asserted `betterCallUtilsSource().toContain(BETTER_CALL_JSON_CONTENT_TYPE.source)`
 * — i.e. that our regex's source text appears SOMEWHERE in the installed
 * `utils.mjs`. That only proves the constant still exists; it doesn't prove
 * `getBody` still USES it as the gate (a future better-call could add a
 * second, broader regex, or repoint `getBody` to it, while leaving the old
 * constant defined and matched by the containment check), and it's brittle
 * in the other direction too — dependent on the dist staying unminified and
 * the `\/` escape surviving verbatim.
 *
 * This drives the REAL, installed `getBody` (resolved from better-auth's own
 * nested better-call copy — see `resolveNestedBetterCall`'s doc comment for
 * why that resolution matters, BS#2558 PR #2566 review Finding 2) with a
 * table of content types, and asserts its JSON/not-JSON verdict agrees with
 * `isBetterCallJsonRequest`'s. Two independent oracles over the same table —
 * this is what actually proves the effective gate, survives dist
 * reformatting/minification, and folds Finding 2's corrected resolution in
 * automatically (a `getBody` that no longer round-trips the way this test
 * expects fails the assertion, not a string search).
 */
describe('isBetterCallJsonRequest agrees with the installed getBody() (behavioral drift detector)', () => {
  let getBody: (request: Request, allowedMediaTypes?: string[]) => Promise<unknown>;

  beforeAll(() => {
    // Fail loud and specific if resolution itself breaks, per Finding 3 —
    // resolveNestedBetterCall already throws an informative error; let it
    // propagate rather than wrapping it, so a future reader sees exactly
    // what this was looking for and why.
    const nestedEntry = resolveNestedBetterCall();
    const distDir = path.dirname(nestedEntry);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require -- deep, non-exported-subpath require by absolute path (better-call doesn't export dist/utils.cjs from its package.json "exports" map); see audit-content-type-parity.test.ts's identical pattern.
    ({ getBody } = require(path.join(distDir, 'utils.cjs')) as {
      getBody: (request: Request, allowedMediaTypes?: string[]) => Promise<unknown>;
    });
  });

  /**
   * Asks the REAL `getBody` "would you take the JSON-parse branch for this
   * Content-Type", the same question `isBetterCallJsonRequest` answers.
   * Passes `undefined` for `allowedMediaTypes` deliberately — that argument
   * is better-call's SEPARATE admission gate (Finding 1's module-doc fix),
   * and this probe must isolate the parse gate alone, the one
   * `isBetterCallJsonRequest` actually mirrors, or a type that fails
   * admission but passes parsing (`application/vnd.api+json`) would produce
   * a false disagreement here that has nothing to do with our predicate.
   *
   * The probe body is a JSON object; `getBody`'s JSON branch returns it
   * parsed back into an equivalent object, every other branch returns
   * something else (a string, ArrayBuffer, Blob, ReadableStream, or a
   * `multipart/form-data` parse failure) — so "did the JSON branch fire" is
   * legible from the return shape alone, with no need to import or
   * re-implement `jsonContentTypeRegex` a second time to check.
   */
  async function getBodyTookJsonBranch(contentType: string): Promise<boolean> {
    const request = new Request('http://localhost/probe', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: JSON.stringify({ probe: true }),
    });
    try {
      const result = await getBody(request, undefined);
      return typeof result === 'object' && result !== null && (result as { probe?: unknown }).probe === true;
    } catch {
      // e.g. multipart/form-data throws trying to parse a non-multipart
      // body as form data — not the JSON branch either way.
      return false;
    }
  }

  it.each([
    'application/json',
    'application/jsonx',
    'application/json-patch+json',
    'application/json5',
    'application/vnd.api+json',
    'application/hal+json',
    'application/ld+json',
    'APPLICATION/JSON',
    'Application/Json-Patch+Json',
    'application/json; charset=utf-8',
    'text/plain',
    'text/html',
    'application/xml',
    'application/octet-stream',
    'application/pdf',
    'image/png',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/json', // does not start with "application/" — outside better-call's surface even though it names json
    '',
  ])('agrees with the real getBody() on %s', async (contentType) => {
    const expected = await getBodyTookJsonBranch(contentType);
    expect(isBetterCallJsonRequest(mockReq(contentType) as never)).toBe(expected);
  });
});

describe('isBetterCallJsonRequest', () => {
  describe('content types better-call parses as JSON (must be accepted — the BS#2558 gap)', () => {
    it.each([
      'application/json',
      'application/jsonx',
      'application/json-patch+json',
      'application/json5',
      'APPLICATION/JSON',
      'Application/Json-Patch+Json',
      'application/json; charset=utf-8',
    ])('accepts %s', (contentType) => {
      expect(isBetterCallJsonRequest(mockReq(contentType) as never)).toBe(true);
    });
  });

  /**
   * BS#2558 PR #2566 review Finding 4: `application/vnd.api+json` (and its
   * siblings `application/hal+json` / `application/ld+json`) do NOT belong
   * in the "must be accepted — the gap" block above — they match
   * better-call's PARSE regex (so this predicate correctly accepts them,
   * and `express.json()` correctly parses their body) but FAIL better-call's
   * separate `allowedMediaTypes` ADMISSION test
   * (`"application/vnd.api+json".includes("application/json")` is `false`),
   * so better-call 415s them regardless of what Express did. That's real,
   * new behavior this PR introduces (these types were previously left
   * unparsed by `express.json()`'s exact-match default) — just not the
   * BS#2558 gap-closing behavior the block above documents. See
   * `json-content-type.ts`'s module doc (Finding 1) for the full gate
   * comparison, and `audit-content-type-parity.test.ts`'s Finding-4 round
   * trip for the empirical proof that better-call still 415s these and the
   * account-audit middleware still records the rejection.
   */
  describe('content types Express now parses but better-call itself still rejects (widened surface, not the BS#2558 gap)', () => {
    it.each(['application/vnd.api+json', 'application/hal+json', 'application/ld+json'])(
      'accepts %s at the Express layer (better-call 415s it downstream — see the round trip in audit-content-type-parity.test.ts)',
      (contentType) => {
        expect(isBetterCallJsonRequest(mockReq(contentType) as never)).toBe(true);
      }
    );
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
