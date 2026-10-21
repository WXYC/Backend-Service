// Compile-time guard for the specialty_shows jsonb shapes (BS#3568), which mirror api.yaml `SpecialtyShowArtwork` and
// `SpecialtyShowSlot`. Never imported or bundled: `tsc --noEmit` (npm run typecheck, strict) enforces it. The Jest
// suites run with strict off, where `string | null` collapses to `string`, so the same check there could never fail.
import type { SpecialtyShowArtwork, SpecialtyShowSlot } from './schema.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const artworkShape: Equal<
  SpecialtyShowArtwork,
  { square_url: string; master_url: string | null; wide_url: string | null }
> = true;

export const cadenceShape: Equal<SpecialtyShowSlot['cadence'], 'weekly' | 'some_weeks' | 'last_of_month'> = true;

export const withoutArt: SpecialtyShowArtwork = {
  square_url: 'https://example.com/sq.jpg',
  master_url: null,
  wide_url: null,
};

// @ts-expect-error square_url is required and not nullable
export const nullSquare: SpecialtyShowArtwork = { square_url: null, master_url: null, wide_url: null };
