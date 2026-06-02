import { filterSpacerGif } from '@wxyc/metadata';

describe('filterSpacerGif', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('returns null for falsy input (%s)', (_label, input) => {
    expect(filterSpacerGif(input)).toBeNull();
  });

  it('returns null when the URL contains spacer.gif', () => {
    expect(filterSpacerGif('https://i.discogs.com/img/spacer.gif')).toBeNull();
  });

  it('returns null when spacer.gif appears anywhere in the URL', () => {
    expect(filterSpacerGif('https://example.com/path/spacer.gif?v=1')).toBeNull();
  });

  it('returns the URL unchanged when it is a real artwork URL', () => {
    const url = 'https://i.discogs.com/R-12345-cover.jpg';
    expect(filterSpacerGif(url)).toBe(url);
  });
});
