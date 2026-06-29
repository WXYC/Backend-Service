/**
 * Unit tests for `resolveComposer` (BS#1499 PR-3).
 *
 * `resolveComposer` is the sole site that maps an LML
 * `DiscogsMatchResult.writer_credits` block onto the BMI-ready
 * `composer` / `composer_source` pair written on the flowsheet row by
 * `finalizeRow`. It is pure (no DB), so this file takes no `pg` marker and
 * does no DB setup — mirroring `synthesize-search-urls-parity.test.ts`.
 *
 * Contract pinned here:
 *   - `provenance: 'track'`   → `composer_source = 'discogs_track'`.
 *   - `provenance: 'release'` → `composer_source = 'discogs_release'`.
 *   - multiple names join with `'; '` (Discogs writer names can carry
 *     commas, e.g. "Last, First", so a comma delimiter would be ambiguous).
 *   - match but `writer_credits` undefined → artist-as-proxy fallback.
 *   - no-match (artwork null)             → artist-as-proxy fallback.
 *
 * The artist-proxy fallback dominating (~79% of plays per LML#699) is
 * expected, not a regression — it mirrors tubafrenzy's existing
 * auto-fill-BMI_COMPOSER-from-Artist default.
 */

import type { DiscogsMatchResult } from '@wxyc/lml-client';
import { resolveComposer } from '../../../../apps/enrichment-worker/enrich';
import type { EnrichRow } from '../../../../apps/enrichment-worker/enrich';

const ROW: EnrichRow = {
  id: 1,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  album_id: null,
};

// Build a minimal artwork carrying only the writer_credits we vary. Other
// DiscogsMatchResult fields are irrelevant to resolveComposer, so the literal
// stays partial; `resolveComposer` only reads `writer_credits`.
const artworkWith = (artwork: Partial<DiscogsMatchResult>): Partial<DiscogsMatchResult> => artwork;

describe('resolveComposer (BS#1499 PR-3)', () => {
  it("provenance 'track' → joined names + 'discogs_track'", () => {
    const artwork = artworkWith({
      writer_credits: {
        names: ['Juana Molina'],
        roles: ['Written-By'],
        provenance: 'track',
        track_position: 'A1',
      },
    });

    expect(resolveComposer(ROW, artwork)).toEqual({
      composer: 'Juana Molina',
      composer_source: 'discogs_track',
    });
  });

  it("provenance 'release' → joined names + 'discogs_release'", () => {
    const artwork = artworkWith({
      writer_credits: {
        names: ['Sessa', 'Bianca Vianna'],
        roles: ['Written-By', 'Music By'],
        provenance: 'release',
      },
    });

    expect(resolveComposer(ROW, artwork)).toEqual({
      composer: 'Sessa; Bianca Vianna',
      composer_source: 'discogs_release',
    });
  });

  it("joins multiple names with '; ' (not ',', which Discogs names can contain)", () => {
    const artwork = artworkWith({
      writer_credits: {
        names: ['Molina, Juana', 'Vianna, Bianca'],
        provenance: 'track',
        track_position: 'A1',
      },
    });

    expect(resolveComposer(ROW, artwork).composer).toBe('Molina, Juana; Vianna, Bianca');
  });

  it("match but writer_credits undefined → artist_name + 'artist_proxy'", () => {
    const artwork = artworkWith({ writer_credits: undefined });

    expect(resolveComposer(ROW, artwork)).toEqual({
      composer: 'Juana Molina',
      composer_source: 'artist_proxy',
    });
  });

  it("writer_credits present but names empty → artist_name + 'artist_proxy'", () => {
    const artwork = artworkWith({ writer_credits: { names: [], provenance: 'release' } });

    expect(resolveComposer(ROW, artwork)).toEqual({
      composer: 'Juana Molina',
      composer_source: 'artist_proxy',
    });
  });

  it("no-match (artwork null) → artist_name + 'artist_proxy'", () => {
    expect(resolveComposer(ROW, null)).toEqual({
      composer: 'Juana Molina',
      composer_source: 'artist_proxy',
    });
  });
});
