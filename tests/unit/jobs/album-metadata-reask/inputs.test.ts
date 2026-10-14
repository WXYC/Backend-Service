/**
 * The re-ask's three input files and the admission rule (BS#3141).
 *
 * The pin export, the removal file and the grading manifest arrive as `\copy`
 * or tooling CSVs that Backend cannot cross-check against a database, so a
 * parser that guessed (a default for an empty id, a skipped bad line) would
 * silently change which albums get rewritten. Every malformed input refuses.
 *
 * `admit` is the one place the decision-2 rule lives, so the dry run's counts
 * and the execute loop's asks cannot drift apart.
 *
 * Card ids are the WXYC example albums (`@wxyc/shared/test-utils`): Juana
 * Molina *DOGA*, Stereolab *Aluminum Tunes*, Jessica Pratt *On Your Own Love
 * Again*. Card 29757 is the one the plan names for `hold_manual`.
 *
 * @see WXYC/Backend-Service#3137
 */

import { createHash } from 'crypto';
import { describe, it, expect } from '@jest/globals';
import { wxycExampleAlbums } from '@wxyc/shared/test-utils';
import {
  admit,
  InputFileError,
  parseGradingManifest,
  parsePinFile,
  parseRemovalFile,
  type ManifestEntry,
  type Tier,
} from '../../../../jobs/album-metadata-reask/inputs';

const DOGA = wxycExampleAlbums.doga.id;
const ALUMINUM_TUNES = wxycExampleAlbums.aluminumTunes.id;
const ON_YOUR_OWN_LOVE_AGAIN = wxycExampleAlbums.onYourOwnLoveAgain.id;
const HOLD_MANUAL_CARD = 29757;

const PIN_HEADER = 'library_id,discogs_release_id,source,updated_at';
const REMOVAL_HEADER = 'library_id,discogs_release_id,source';
const MANIFEST_HEADER =
  'library_id,stored_release_id,pin_release_id,pin_source,stored_title_score,pin_title_score,stored_play_rate,pin_play_rate,excluded_other_plays,excluded_inferred_plays,tier,expected_release_id';

const pinFile = (...lines: string[]) => [PIN_HEADER, ...lines].join('\n') + '\n';
const removalFile = (...lines: string[]) => [REMOVAL_HEADER, ...lines].join('\n') + '\n';
const manifestFile = (...lines: string[]) => [MANIFEST_HEADER, ...lines].join('\n') + '\n';

const PIN_LINE = `${DOGA},1289570,alex-l-2026,2026-10-14 09:53:12.123456-07`;
const REMOVAL_LINE = `${DOGA},1289570,alex-l-2026-masters-api`;
const MANIFEST_LINE = `${DOGA},4804816,1289570,alex-l-2026,61.5,92,0.2,0.75,3,1,rebind,`;

describe('input file parsing', () => {
  it('parses a pin export, keyed by card, with its hash and row count', () => {
    const text = pinFile(PIN_LINE, `${ON_YOUR_OWN_LOVE_AGAIN},225068,manual-correction-2026-10,2026-10-14 10:15:00-07`);

    const parsed = parsePinFile(text);

    expect(parsed.rowCount).toBe(2);
    expect(parsed.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(parsed.byLibraryId.get(DOGA)).toEqual({
      library_id: DOGA,
      discogs_release_id: 1289570,
      source: 'alex-l-2026',
      updated_at: '2026-10-14 09:53:12.123456-07',
    });
    expect(parsed.rows.map((r) => r.library_id)).toEqual([DOGA, ON_YOUR_OWN_LOVE_AGAIN]);
  });

  it('parses a removal file', () => {
    const parsed = parseRemovalFile(removalFile(REMOVAL_LINE));

    expect(parsed.rows).toEqual([{ library_id: DOGA, discogs_release_id: 1289570, source: 'alex-l-2026-masters-api' }]);
  });

  it('parses a manifest, reading an empty grade or expected release as null', () => {
    const parsed = parseGradingManifest(
      manifestFile(MANIFEST_LINE, `${ALUMINUM_TUNES},77,88,alex-l-2026-masters-api,70,70,,,0,4,hold_ungradeable,512890`)
    );

    expect(parsed.byLibraryId.get(DOGA)).toEqual({
      library_id: DOGA,
      stored_release_id: 4804816,
      pin_release_id: 1289570,
      pin_source: 'alex-l-2026',
      stored_title_score: 61.5,
      pin_title_score: 92,
      stored_play_rate: 0.2,
      pin_play_rate: 0.75,
      excluded_other_plays: 3,
      excluded_inferred_plays: 1,
      tier: 'rebind',
      expected_release_id: null,
    });
    expect(parsed.byLibraryId.get(ALUMINUM_TUNES)).toMatchObject({
      stored_play_rate: null,
      pin_play_rate: null,
      tier: 'hold_ungradeable',
      expected_release_id: 512890,
    });
  });

  it.each([
    ['a byte-order mark', `\uFEFF${pinFile(PIN_LINE)}`],
    ['CRLF line endings', pinFile(PIN_LINE).replace(/\n/g, '\r\n')],
    ['no trailing newline', pinFile(PIN_LINE).trimEnd()],
  ])('tolerates %s', (_label, text) => {
    const parsed = parsePinFile(text);

    expect(parsed.rowCount).toBe(1);
    expect(parsed.rows[0].library_id).toBe(DOGA);
    // The hash covers the bytes as given, so it names the exact file that was read.
    expect(parsed.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('hashes a Buffer the same as its text', () => {
    const text = pinFile(PIN_LINE);

    expect(parsePinFile(Buffer.from(text, 'utf8')).sha256).toBe(parsePinFile(text).sha256);
  });

  type Parser = (raw: string) => unknown;
  const pins: Parser = parsePinFile;
  const removals: Parser = parseRemovalFile;
  const manifest: Parser = parseGradingManifest;

  it.each<[string, Parser, string, RegExp]>([
    ['an empty file', pins, '', /header/],
    ['a bad header', pins, 'library_id,discogs_release_id,source\n', /header/],
    ['a reordered header', removals, 'discogs_release_id,library_id,source\n', /header/],
    ['a BOM in the middle of the header', pins, `library_id,\uFEFFdiscogs_release_id,source,updated_at\n`, /header/],
    ['a non-integer id', pins, pinFile(`${DOGA},12x,alex-l-2026,2026-10-14 09:53:12-07`), /line 2.*discogs_release_id/],
    ['a decimal id', removals, removalFile(`${DOGA}.0,1289570,alex-l-2026`), /line 2.*library_id/],
    ['an empty id', pins, pinFile(`,1289570,alex-l-2026,2026-10-14 09:53:12-07`), /line 2.*library_id/],
    ['a zero release', pins, pinFile(`${DOGA},0,alex-l-2026,2026-10-14 09:53:12-07`), /line 2.*discogs_release_id/],
    ['a negative release', removals, removalFile(`${DOGA},-5,alex-l-2026`), /line 2.*discogs_release_id/],
    ['an id past the safe-integer range', removals, removalFile(`9007199254740993,1,alex-l-2026`), /library_id/],
    ['a duplicate card', pins, pinFile(PIN_LINE, PIN_LINE), /line 3.*duplicate library_id/],
    ['a duplicate card in a manifest', manifest, manifestFile(MANIFEST_LINE, MANIFEST_LINE), /line 3.*duplicate/],
    ['too few columns', removals, removalFile(`${DOGA},1289570`), /line 2.*3 columns/],
    ['too many columns', removals, removalFile(`${DOGA},1289570,alex-l-2026,extra`), /line 2.*3 columns/],
    ['a quoted value', removals, removalFile(`${DOGA},1289570,"alex-l-2026"`), /line 2.*quoted/],
    ['an empty source', removals, removalFile(`${DOGA},1289570,`), /line 2.*source/],
    ['an unparseable timestamp', pins, pinFile(`${DOGA},1289570,alex-l-2026,yesterday`), /line 2.*updated_at/],
    ['a blank line inside the file', removals, removalFile(REMOVAL_LINE, '', REMOVAL_LINE), /line 3/],
    ['an unknown tier', manifest, manifestFile(MANIFEST_LINE.replace('rebind', 'rebind_maybe')), /line 2.*tier/],
    ['a hold_unmanifested tier', manifest, manifestFile(MANIFEST_LINE.replace('rebind', 'hold_unmanifested')), /tier/],
    ['a non-numeric grade', manifest, manifestFile(MANIFEST_LINE.replace('61.5', 'n/a')), /line 2.*stored_title_score/],
    ['a grade in exponent form', manifest, manifestFile(MANIFEST_LINE.replace('61.5', '6e1')), /stored_title_score/],
    ['a grade with two points', manifest, manifestFile(MANIFEST_LINE.replace('61.5', '6.1.5')), /stored_title_score/],
    ['an empty excluded count', manifest, manifestFile(MANIFEST_LINE.replace(',3,1,', ',,1,')), /excluded_other_plays/],
    ['a zero expected release', manifest, manifestFile(MANIFEST_LINE.replace(/,$/, ',0')), /expected_release_id/],
  ])('refuses %s', (_label, parse, text, message) => {
    expect(() => parse(text)).toThrow(InputFileError);
    expect(() => parse(text)).toThrow(message);
  });
});

describe('admit', () => {
  const entry = (library_id: number, tier: Tier, pin_source: string): ManifestEntry => ({
    library_id,
    stored_release_id: 4804816,
    pin_release_id: 1289570,
    pin_source,
    stored_title_score: 70,
    pin_title_score: 90,
    stored_play_rate: null,
    pin_play_rate: null,
    excluded_other_plays: 0,
    excluded_inferred_plays: 0,
    tier,
    expected_release_id: null,
  });

  const SOURCES = ['alex-l-2026', 'alex-l-2026-masters-api', 'manual-correction-2026-10'] as const;
  const TIERS: Tier[] = ['rebind', 'hold_stored_better', 'hold_ungradeable', 'hold_manual'];

  // The decision-2 rule written out longhand, so the table states the policy
  // rather than re-deriving it from the code under test.
  const expected = (reason: 'pin_mismatch' | 'pin_removed', tier: Tier, source: string) => {
    if (reason === 'pin_removed') return tier === 'hold_manual' ? { ask: false, hold: 'hold_manual' } : { ask: true };
    if (tier === 'rebind') return { ask: true };
    if (tier === 'hold_ungradeable' && source === 'alex-l-2026') return { ask: true };
    return { ask: false, hold: tier };
  };

  const cases = (['pin_mismatch', 'pin_removed'] as const).flatMap((reason) =>
    TIERS.flatMap((tier) => SOURCES.map((source) => [reason, tier, source, expected(reason, tier, source)] as const))
  );

  it.each(cases)('%s with tier %s and pin source %s', (reason, tier, source, outcome) => {
    const manifestEntry = entry(DOGA, tier, source);

    const result = admit({ legacy_release_id: DOGA, reason }, new Map([[DOGA, manifestEntry]]));

    expect(result).toEqual(outcome.ask ? { ask: true, entry: manifestEntry } : outcome);
  });

  it.each([
    ['pin_mismatch', 'hold_ungradeable', 'alex-l-2026', true],
    ['pin_mismatch', 'hold_ungradeable', 'alex-l-2026-masters-api', false],
    ['pin_mismatch', 'hold_ungradeable', 'manual-correction-2026-10', false],
  ] as const)('pins the ungradeable exception: %s %s %s asked=%s', (reason, tier, source, ask) => {
    expect(admit({ legacy_release_id: DOGA, reason }, new Map([[DOGA, entry(DOGA, tier, source)]])).ask).toBe(ask);
  });

  it.each(['pin_mismatch', 'pin_removed'] as const)('holds card 29757 (hold_manual) as a %s row', (reason) => {
    const manifestMap = new Map([[HOLD_MANUAL_CARD, entry(HOLD_MANUAL_CARD, 'hold_manual', 'alex-l-2026')]]);

    expect(admit({ legacy_release_id: HOLD_MANUAL_CARD, reason }, manifestMap)).toEqual({
      ask: false,
      hold: 'hold_manual',
    });
  });

  it.each(['pin_mismatch', 'pin_removed'] as const)('holds a %s card missing from the manifest', (reason) => {
    const manifestMap = new Map([[DOGA, entry(DOGA, 'rebind', 'alex-l-2026')]]);

    expect(admit({ legacy_release_id: ON_YOUR_OWN_LOVE_AGAIN, reason }, manifestMap)).toEqual({
      ask: false,
      hold: 'hold_unmanifested',
    });
  });

  it('admits from a parsed manifest', () => {
    const parsed = parseGradingManifest(manifestFile(MANIFEST_LINE));

    expect(admit({ legacy_release_id: DOGA, reason: 'pin_mismatch' }, parsed.byLibraryId)).toEqual({
      ask: true,
      entry: parsed.byLibraryId.get(DOGA),
    });
  });
});
