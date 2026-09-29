// The unit suite auto-mocks drizzle-orm (tests/__mocks__/drizzle-orm.ts): the
// `sql` tag returns a MockSQL instance exposing the interpolated values
// verbatim, so `.values[0]` on a single-hole `sql`to_tsquery('simple',
// ${expr})`` fragment is exactly the tsquery expression text this builder
// composed — no re-rendering needed. `tests/utils/catalog-search-sql-mock.ts`
// relies on the same shape.
import { buildPrefixTsquery, type PrefixTsquery } from '../../../apps/backend/utils/tsquery';
import { wxycCanonicalArtistNames } from '@wxyc/shared/test-utils';

/** Pull the bound parameter text out of a mocked single-hole `sql` fragment. */
function param(node: PrefixTsquery['tsquery']): string {
  return (node as unknown as { values: unknown[] }).values[0] as string;
}

/**
 * Count of `&`-joined operands in a rendered expression. Every operand is a
 * quoted lexeme (optionally `:*`-suffixed), so splitting on the AND
 * separator counts them directly.
 */
function operandCount(expr: string): number {
  return expr.split(' & ').length;
}

/**
 * Every apostrophe in the raw input must survive as a doubled, escaped pair
 * inside its quoted lexeme -- never as a lone quote that would terminate the
 * lexeme early. Stripping every doubled pair should leave exactly two
 * quote characters per operand (the lexeme's own open/close), never an odd
 * leftover.
 */
function assertNoUnescapedApostrophe(expr: string): void {
  const withoutEscapedPairs = expr.replace(/''/g, '');
  const remainingQuotes = (withoutEscapedPairs.match(/'/g) ?? []).length;
  expect(remainingQuotes).toBe(2 * operandCount(expr));
}

describe('buildPrefixTsquery', () => {
  describe.each(wxycCanonicalArtistNames)('%s', (name) => {
    it('prefixes only the last token, keeps every earlier token exact, and stays under the operand cap', () => {
      const built = buildPrefixTsquery(name);
      expect(built).not.toBeNull();
      const tsqueryExpr = param(built.tsquery);
      const exactExpr = param(built.exactTsquery);

      // Everything but the very last operand is byte-identical between the
      // two variants, and the last operand differs by exactly a trailing
      // `:*` -- which is simultaneously "last token prefixed" and "earlier
      // tokens exact" and "the exact variant has no `:*` anywhere", since a
      // stray `:*` on an earlier operand would break this equality.
      expect(tsqueryExpr).toBe(`${exactExpr}:*`);
      expect(exactExpr).not.toMatch(/:\*/);

      expect(operandCount(exactExpr)).toBeLessThanOrEqual(16);
      assertNoUnescapedApostrophe(tsqueryExpr);
      assertNoUnescapedApostrophe(exactExpr);
    });
  });

  describe('edge cases', () => {
    it('returns null for pure punctuation (no lexeme character anywhere)', () => {
      // `!!!` is a real WXYC artist; there is no tsquery that could match it.
      expect(buildPrefixTsquery('!!!')).toBeNull();
    });

    it('returns null when no token carries a letter or digit', () => {
      expect(buildPrefixTsquery('$$$')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(buildPrefixTsquery('   ')).toBeNull();
    });

    it('leaves a leading "-" on the first of several tokens completely alone (ADR 0015)', () => {
      // Quoting already retires the exclusion operator; stripping it would be
      // a no-op here and a regression for a digit-led token elsewhere. The
      // builder must not special-case it at all.
      const built = buildPrefixTsquery('-autechre stereolab');
      expect(param(built.exactTsquery)).toBe("'-autechre' & 'stereolab'");
      expect(param(built.tsquery)).toBe("'-autechre' & 'stereolab':*");
    });

    it('leaves a leading "-" before a digit alone, where stripping would silently break matching (ADR 0015)', () => {
      // `to_tsquery('simple', $$'-3d':*$$)` keeps the sign as part of the
      // signed-int lexeme and matches `to_tsvector('simple','Minus 5 -3d
      // World')`; a stripped `'3d':*` does not (measured on PG 18.6).
      const built = buildPrefixTsquery('-3d');
      expect(param(built.exactTsquery)).toBe("'-3d'");
      expect(param(built.tsquery)).toBe("'-3d':*");
    });

    it.each([['foo\\'], ['cat:'], ['(cat'], ['a<b'], ['x|y'], ['cat*'], ['a&'], ['!cat'], ['cat"'], ['c(a)t']])(
      'neutralizes every metacharacter in %j so none reaches to_tsquery outside a quoted lexeme',
      (input) => {
        const built = buildPrefixTsquery(input);
        expect(built).not.toBeNull();
        for (const expr of [param(built.tsquery), param(built.exactTsquery)]) {
          const lexemes = [...expr.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
          expect(lexemes.length).toBeGreaterThan(0);
          // Inside a lexeme: no metacharacter at all (`'foo\\':*` raises 42601).
          for (const lexeme of lexemes) expect(lexeme).not.toMatch(/[&|!()<>:*\\"]/);
          // Outside the lexemes: only the builder's own ` & ` and `:*`.
          expect(expr.replace(/'(?:[^']|'')*'/g, '')).toMatch(/^(?:(?: & )|(?::\*))*$/);
        }
      }
    );

    it('treats "&" as a token separator, not literal content', () => {
      const built = buildPrefixTsquery('Belle & Sebastian');
      expect(param(built.exactTsquery)).toBe("'Belle' & 'Sebastian'");
      expect(param(built.tsquery)).toBe("'Belle' & 'Sebastian':*");
    });

    it('escapes an interior apostrophe by doubling it rather than stripping it', () => {
      // `to_tsvector('simple', "D'Angelo")` is `'angelo':2 'd':1` -- the
      // apostrophe is a token boundary the parser needs, not junk to drop.
      const built = buildPrefixTsquery("D'Angelo");
      expect(param(built.exactTsquery)).toBe("'D''Angelo'");
      expect(param(built.tsquery)).toBe("'D''Angelo':*");
    });

    it('builds a quoted phrase identically to the same words unquoted (ADR 0015 -- quotes are inert)', () => {
      const quoted = buildPrefixTsquery('"cat power"');
      const bare = buildPrefixTsquery('cat power');
      expect(param(quoted.tsquery)).toBe(param(bare.tsquery));
      expect(param(quoted.exactTsquery)).toBe(param(bare.exactTsquery));
      expect(param(quoted.exactTsquery)).toBe("'cat' & 'power'");
    });

    it('keeps a bare "or" as an ordinary AND\'d token, never disjunction (ADR 0015)', () => {
      const built = buildPrefixTsquery('cat or power');
      expect(param(built.exactTsquery)).toBe("'cat' & 'or' & 'power'");
      expect(param(built.tsquery)).toBe("'cat' & 'or' & 'power':*");
    });

    it('drops a bare double quote, matching how the parser would discard it unstripped', () => {
      // `12"` lexes to the single lexeme `12` -- the trailing quote carries
      // no query-building meaning on this surface (ADR 0015).
      const built = buildPrefixTsquery('12"');
      expect(param(built.exactTsquery)).toBe("'12'");
      expect(param(built.tsquery)).toBe("'12':*");
    });

    it('caps operands at 16 by dropping the EARLIEST tokens, keeping the last-typed token prefixed', () => {
      const tokens = Array.from({ length: 20 }, (_, i) => `tok${i}`);
      const built = buildPrefixTsquery(tokens.join(' '));
      const exactExpr = param(built.exactTsquery);

      expect(operandCount(exactExpr)).toBe(16);
      for (let i = 0; i < 4; i++) expect(exactExpr).not.toContain(`'tok${i}'`);
      for (let i = 4; i < 20; i++) expect(exactExpr).toContain(`'tok${i}'`);
      // The last-typed token (tok19) is still the one that gets `:*`.
      expect(param(built.tsquery)).toBe(`${exactExpr}:*`);
      expect(param(built.tsquery).endsWith("'tok19':*")).toBe(true);
    });

    it('AND-combines multiple tokens so a second partial token still narrows results', () => {
      const built = buildPrefixTsquery('stereolab transien');
      expect(param(built.exactTsquery)).toBe("'stereolab' & 'transien'");
      expect(param(built.tsquery)).toBe("'stereolab' & 'transien':*");
    });
  });
});
