/**
 * One table of artist `code_letters` and whether each names a compilation (BS#3286). Two tiers read it so the TS
 * predicate and its SQL form cannot drift apart: `isVariousArtists` (tests/unit/services/requestLine/types.test.ts)
 * and the `displayedArtistName` fragment's `V/A` prefix, executed against real rows (tests/integration/fcc-notes.spec.js).
 * Every value fits `artists.code_letters` (varchar(4)). The `Z-` arm is case-sensitive; `V/A` is not, and surrounding
 * spaces are ignored.
 */
const CODE_LETTERS_TABLE = [
  ['V/A', true],
  ['v/a ', true],
  [' V/A', true],
  ['Z-R', true],
  ['Z--', true],
  ['z-r', false],
  ['VA', false],
  ['JPRA', false],
  ['MOLI', false],
];

module.exports = { CODE_LETTERS_TABLE };
