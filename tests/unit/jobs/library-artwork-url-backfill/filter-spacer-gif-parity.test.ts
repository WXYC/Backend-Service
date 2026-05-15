/**
 * Parity test: the inline `filterSpacerGif` in
 * `jobs/library-artwork-url-backfill/enrich.ts` MUST be truthy/falsy-
 * equivalent to the canonical
 * `apps/backend/services/metadata/metadata.service.ts#filterSpacerGif`
 * for every input the runtime exercises (BS#890).
 *
 * Mirror of `tests/unit/jobs/flowsheet-metadata-backfill/filter-spacer-gif-parity.test.ts`
 * — both jobs keep an inline copy for build-graph isolation from
 * `apps/backend`. Either implementation drifting fails this test loudly.
 */

import { filterSpacerGif as inlineFilter } from '../../../../jobs/library-artwork-url-backfill/enrich';
import { filterSpacerGif as canonicalFilter } from '../../../../apps/backend/services/metadata/metadata.service';

describe('filterSpacerGif parity (library-artwork-url-backfill inline ↔ canonical)', () => {
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
    expect(Boolean(inlineOut)).toBe(Boolean(canonicalOut));
    if (inlineOut && canonicalOut) {
      expect(inlineOut).toBe(canonicalOut);
    }
  });
});
