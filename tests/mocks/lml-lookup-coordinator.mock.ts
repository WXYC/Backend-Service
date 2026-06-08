/**
 * Shared mock for `lmlLookupCoordinator` (BS#885). Used by every test that
 * exercises a path through the coordinator without wanting the real
 * in-flight + cache + Sentry machinery.
 *
 * BS#1355: the production coordinator also runs a `requireSearchType: 'direct'`
 * gate. The mock mirrors it so tests of the migrated callsites (addAlbum
 * artwork, fireAndForgetCanonicalEntity, enrichWithArtwork, rotation picker)
 * see the same null-vs-response contract as production.
 *
 * Variable named with the `mock` prefix because jest.mock factory functions
 * cannot reference out-of-scope variables unless they are. Import this and
 * call from inside the factory:
 *
 *   jest.mock('.../lookup-coordinator', () => ({
 *     lmlLookupCoordinator: {
 *       lookup: async (artist, album, song, opts) => {
 *         const response = await mockLookupMetadata(artist, album, song, opts);
 *         return mockApplyTrustGate(response, opts);
 *       },
 *     },
 *   }));
 *
 * Footgun: if a test's mocked response omits `search_type`, the strict-
 * inequality check `undefined !== 'direct'` evaluates true and the gate
 * returns null. Either always set `search_type` in fixtures or use a
 * response builder that defaults it.
 */
export function mockApplyTrustGate(
  response: { search_type?: string } | null | undefined,
  opts: Record<string, unknown> | undefined
): { search_type?: string } | null {
  if (!response) return null;
  const requireSearchType = opts?.requireSearchType;
  if (typeof requireSearchType === 'string' && response.search_type !== requireSearchType) {
    return null;
  }
  return response;
}
