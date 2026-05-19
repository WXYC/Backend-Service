/**
 * Unit tests for the canonical `filterSpacerGif` (BS#890).
 *
 * `apps/backend/services/metadata/metadata.service.ts` exports the single
 * source of truth that all `apps/backend/**` consumers import. Inline
 * copies in `jobs/flowsheet-metadata-backfill/enrich.ts` and
 * `jobs/library-artwork-url-backfill/enrich.ts` are kept for build-graph
 * isolation and pinned to this canonical via parity tests.
 *
 * The contract: the function drops Discogs `spacer.gif` placeholder URLs
 * (a literal substring match — not a regex, not case-insensitive) and
 * passes everything else through. Returns `undefined` for null/undefined/
 * empty/spacer inputs so the result can be assigned to optional response
 * fields directly.
 */

import { filterSpacerGif } from '../../../../apps/backend/services/metadata/metadata.service';

describe('filterSpacerGif (canonical)', () => {
  it('returns undefined for null', () => {
    expect(filterSpacerGif(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(filterSpacerGif(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(filterSpacerGif('')).toBeUndefined();
  });

  it('passes through a real artwork URL', () => {
    const url = 'https://i.discogs.com/Y6V_TKqj_xJ8RbS.jpeg';
    expect(filterSpacerGif(url)).toBe(url);
  });

  it('drops the canonical Discogs spacer.gif placeholder', () => {
    expect(filterSpacerGif('https://s.discogs.com/images/spacer.gif')).toBeUndefined();
  });

  it('drops any URL containing "spacer.gif" as a substring', () => {
    // Defensive: the check is a substring match, not endsWith, so any
    // mid-path occurrence is treated as a placeholder.
    expect(filterSpacerGif('https://example.com/a/spacer.gif/x')).toBeUndefined();
  });

  it('is case-sensitive — capitalized "Spacer.gif" passes through', () => {
    // Pins the literal-substring behavior. The Discogs response uses
    // lowercase "spacer.gif" verbatim; capitalized variants would be
    // suspect inputs that warrant attention rather than silent drop.
    const url = 'https://i.discogs.com/Spacer.gif';
    expect(filterSpacerGif(url)).toBe(url);
  });
});
