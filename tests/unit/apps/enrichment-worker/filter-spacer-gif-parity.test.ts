/**
 * Parity test: the inline `filterSpacerGif` in
 * `apps/enrichment-worker/enrich.ts` MUST be truthy/falsy-equivalent to the
 * canonical `apps/backend/services/metadata/metadata.service.ts#filterSpacerGif`
 * for every input the runtime exercises (BS#890).
 *
 * The inline copy exists for the same build-graph-isolation reason as the
 * backfill's: `apps/enrichment-worker` is bundled independently of
 * `apps/backend` so it can run as its own Docker container. The cost of
 * that isolation is silent drift, which is what this test pins.
 *
 * The companion `scripts/check-spacer-gif-callsites.sh` CI guard pins the
 * allowlist of source files that may mention `'spacer.gif'`. Together they
 * make a third drift impossible without two files changing in the same
 * commit.
 *
 * Sibling tests:
 *   - `tests/unit/jobs/flowsheet-metadata-backfill/filter-spacer-gif-parity.test.ts`
 *   - `tests/unit/jobs/library-artwork-url-backfill/filter-spacer-gif-parity.test.ts`
 */

import { filterSpacerGif as inlineFilter } from '../../../../apps/enrichment-worker/enrich';
import { filterSpacerGif as canonicalFilter } from '../../../../apps/backend/services/metadata/metadata.service';

describe('filterSpacerGif parity (enrichment-worker inline ↔ canonical)', () => {
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
