// The unit suite auto-mocks drizzle-orm (tests/__mocks__/drizzle-orm.ts), but
// this suite only exercises a pure string builder — no `sql` tag involved.
import { buildPrefixTsquery } from '../../../apps/backend/utils/tsquery';

describe('buildPrefixTsquery', () => {
  it('suffixes a single token with the prefix-match operator', () => {
    // BS#670: `websearch_to_tsquery('simple','autec')` lexes to `autec`, which
    // does not match Autechre's `autechre` lexeme. `:*` is what closes that gap.
    expect(buildPrefixTsquery('autec')).toBe("'autec':*");
  });

  it('AND-combines multiple tokens, each independently prefixed', () => {
    // Preserves the AND semantics websearch_to_tsquery gave us: "stereolab
    // transient" must not return the whole Stereolab discography.
    expect(buildPrefixTsquery('stereolab transient')).toBe("'stereolab':* & 'transient':*");
  });

  it('escapes an apostrophe by doubling it rather than stripping it', () => {
    // `to_tsvector('simple', 'D''Angelo')` is `'angelo':2 'd':1` — two lexemes.
    // Stripping the apostrophe yields the single lexeme `dangelo`, which matches
    // nothing; doubling it keeps the token splittable by the same parser.
    expect(buildPrefixTsquery("d'ang")).toBe("'d''ang':*");
  });

  it('treats tsquery operators as token separators instead of emitting them', () => {
    // `&` would otherwise reach to_tsquery as an operator with an empty right
    // operand. Replacing with whitespace makes "Belle & Sebastian" two tokens.
    expect(buildPrefixTsquery('belle & sebastian')).toBe("'belle':* & 'sebastian':*");
  });

  it.each([
    ['&', 'ampersand'],
    ['|', 'or'],
    ['!', 'not'],
    ['(', 'open group'],
    [')', 'close group'],
    ['<', 'phrase open'],
    ['>', 'phrase close'],
    [':', 'weight/prefix marker'],
    ['*', 'prefix star'],
    ['\\', 'escape character'],
  ])('neutralizes the tsquery metacharacter %s (%s)', (ch) => {
    expect(buildPrefixTsquery(`ab${ch}cd`)).toBe("'ab':* & 'cd':*");
  });

  it('returns null for a pure-punctuation query so the caller can skip the path', () => {
    // `!!!` is a real WXYC artist. `to_tsvector('simple','!!!')` is empty, so
    // there is no tsquery that could match it — the trigram path owns this case.
    expect(buildPrefixTsquery('!!!')).toBeNull();
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['&|!', 'operators only'],
  ])('returns null for %s (%s)', (input) => {
    // to_tsquery('simple','') raises a NOTICE and yields an empty tsquery that
    // matches nothing; returning null keeps that query off the wire entirely.
    expect(buildPrefixTsquery(input)).toBeNull();
  });

  it('preserves non-ASCII letters', () => {
    // Nilüfer Yanya, Sigur Rós, Csillagrablók — the `simple` config keeps the
    // diacritics in the lexeme, so the query half must keep them too.
    expect(buildPrefixTsquery('nilüf')).toBe("'nilüf':*");
    expect(buildPrefixTsquery('rós')).toBe("'rós':*");
  });

  it('keeps dots and hyphens inside a token for the parser to split', () => {
    // `to_tsvector('simple','M.A.N.D.Y.')` is the single lexeme `m.a.n.d.y`, and
    // `to_tsquery('simple',"'m.a.n.d.y':*")` reproduces it. Stripping the dots
    // would emit five one-letter tokens instead.
    expect(buildPrefixTsquery('m.a.n.d.y')).toBe("'m.a.n.d.y':*");
    // Hyphenated names lex to the compound plus its parts; the quoted form
    // expands to the adjacency query that matches them.
    expect(buildPrefixTsquery('chuquimamani-condori')).toBe("'chuquimamani-condori':*");
  });

  it('drops a token with no letters or digits, keeping its siblings', () => {
    // A lexeme-less token contributes an empty operand: to_tsquery would raise a
    // NOTICE and return a tsquery that matches nothing, taking the whole
    // AND-chain down with it.
    expect(buildPrefixTsquery('sunn $$$')).toBe("'sunn':*");
  });

  it('returns null when every token is lexeme-less', () => {
    expect(buildPrefixTsquery('$$$ ...')).toBeNull();
  });

  it('collapses runs of whitespace rather than emitting empty tokens', () => {
    expect(buildPrefixTsquery('  stereolab \t\n transient  ')).toBe("'stereolab':* & 'transient':*");
  });
});
