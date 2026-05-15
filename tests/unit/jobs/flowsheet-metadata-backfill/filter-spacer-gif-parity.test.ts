/**
 * Parity test: the inline `filterSpacerGif` in
 * `jobs/flowsheet-metadata-backfill/enrich.ts` MUST be truthy/falsy-
 * equivalent to the canonical
 * `apps/backend/services/metadata/metadata.service.ts#filterSpacerGif`
 * for every input the runtime exercises (BS#890).
 *
 * The inline copy returns `null` (it writes to nullable DB columns) and
 * the canonical returns `undefined` (it writes to JSON response fields),
 * so this test does not require strict-equality output; only that the two
 * agree on "is this URL a real artwork URL or a spacer/empty/null." The
 * truthy URL output, when present, must match exactly.
 *
 * If either implementation drifts, this test fails loudly. The companion
 * `scripts/check-spacer-gif-callsites.sh` CI guard pins the allowlist of
 * source files that may mention the string `spacer.gif` so a third copy
 * cannot grow silently.
 */

import { filterSpacerGif as inlineFilter } from '../../../../jobs/flowsheet-metadata-backfill/enrich';
import { filterSpacerGif as canonicalFilter } from '../../../../apps/backend/services/metadata/metadata.service';

describe('filterSpacerGif parity (backfill inline ↔ canonical)', () => {
  const cases: Array<{ name: string; input: string | null | undefined }> = [
    { name: 'null', input: null },
    { name: 'undefined', input: undefined },
    { name: 'empty string', input: '' },
    { name: 'plain URL', input: 'https://i.discogs.com/Y6V_TKqj_xJ8RbS.jpeg' },
    { name: 'Discogs spacer.gif placeholder', input: 'https://s.discogs.com/images/spacer.gif' },
    { name: 'URL with "spacer.gif" embedded mid-path', input: 'https://example.com/a/spacer.gif/x' },
    {
      name: 'capitalized "Spacer.gif" does not match the canonical literal',
      input: 'https://i.discogs.com/Spacer.gif',
    },
  ];

  it.each(cases)('truthy/falsy parity on $name', ({ input }) => {
    const inlineOut = inlineFilter(input);
    const canonicalOut = canonicalFilter(input);
    // Both should be truthy or both should be falsy.
    expect(Boolean(inlineOut)).toBe(Boolean(canonicalOut));
    // When both return a URL, the URL itself must match exactly.
    if (inlineOut && canonicalOut) {
      expect(inlineOut).toBe(canonicalOut);
    }
  });
});
