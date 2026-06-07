import { cleanDiscogsBio } from '@wxyc/metadata';

describe('cleanDiscogsBio', () => {
  it('strips [a=Artist] markup, keeping the inner text', () => {
    expect(cleanDiscogsBio('Member of [a=Stereolab].')).toBe('Member of Stereolab.');
  });

  it('strips [l=Label] markup', () => {
    expect(cleanDiscogsBio('Signed to [l=Drag City].')).toBe('Signed to Drag City.');
  });

  it('strips [r=Release] markup', () => {
    expect(cleanDiscogsBio('See [r=12345] for details.')).toBe('See 12345 for details.');
  });

  it('strips [m=Master] markup', () => {
    expect(cleanDiscogsBio('Master release: [m=678].')).toBe('Master release: 678.');
  });

  it('converts [url=...]text[/url] to the text', () => {
    expect(cleanDiscogsBio('Visit [url=https://example.com]their site[/url] for more.')).toBe(
      'Visit their site for more.'
    );
  });

  it('handles multiple markup forms in one bio', () => {
    const input = 'Member of [a=Stereolab] on [l=Drag City]. See [url=https://example.com]here[/url].';
    expect(cleanDiscogsBio(input)).toBe('Member of Stereolab on Drag City. See here.');
  });

  it('returns the input unchanged when there is no markup', () => {
    expect(cleanDiscogsBio('A plain bio with no tags.')).toBe('A plain bio with no tags.');
  });

  describe('numeric-id entity references', () => {
    it.each([
      ['a', 'Co-founder of duo, [a8390436].', 'Co-founder of duo.'],
      ['l', 'Released on [l123] in 2003.', 'Released on in 2003.'],
      ['r', 'See [r45] for details.', 'See for details.'],
      ['m', 'Master release: [m999].', 'Master release.'],
    ])('strips [%s<id>] numeric-id references', (_letter, input, expected) => {
      expect(cleanDiscogsBio(input)).toBe(expected);
    });

    it.each([
      [':', 'Producer: [a8390436].', 'Producer.'],
      [';', 'duo; [l123].', 'duo.'],
    ])('eats leading "%s" punctuation along with the numeric-id token', (_punct, input, expected) => {
      expect(cleanDiscogsBio(input)).toBe(expected);
    });

    it('matches the acceptance example from issue #1354', () => {
      expect(
        cleanDiscogsBio(
          'Seoul-based producer and DJ. Co-founder of Computer Music Club and half of leftfield ambient duo, [a8390436].'
        )
      ).toBe('Seoul-based producer and DJ. Co-founder of Computer Music Club and half of leftfield ambient duo.');
    });

    it('squashes the double-space left when a token sits between words', () => {
      expect(cleanDiscogsBio('Member of [a8390436] and other groups.')).toBe('Member of and other groups.');
    });

    it('trims leading whitespace when a token starts the bio', () => {
      expect(cleanDiscogsBio('[a8390436] is the producer.')).toBe('is the producer.');
    });

    it('leaves [a=Name] and other named-reference behaviour unchanged', () => {
      expect(cleanDiscogsBio('Member of [a=Stereolab] and [r=12345].')).toBe('Member of Stereolab and 12345.');
    });
  });
});
