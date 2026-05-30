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
});
