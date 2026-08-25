import { classifyArtworkProvenance, decodeDiscogsImageKey, isWrongArtworkProvenance } from '@wxyc/metadata';

/**
 * Fixtures are verbatim `artwork_url` values read from prod
 * `wxyc_schema.album_metadata` / `wxyc_schema.library` on 2026-08-24, one per
 * observed class. They are not synthesized: the whole point of the decoder is
 * that it agrees with what Discogs actually serves, and a hand-rolled URL
 * would only pin my own encoder's assumptions (BS#2258).
 */
const RELEASE_COVER =
  'https://i.discogs.com/FnUJPxhECqKDvFoT-z2-GT9g5uRYLE8rjIetCX4lsMs/rs:fit/g:sm/q:90/h:600/w:593/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9SLTEzNzEy/OS0xMjIyODc4OTE5/LmpwZWc.jpeg';
const ARTIST_IMAGE =
  'https://i.discogs.com/Lj7_VfsOG9ZjqxZAxm0VEjQSQHvbG-wy-Zj9KRaEIgo/rs:fit/g:sm/q:90/h:606/w:600/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9BLTMyNjgt/MTY2Mzg3MTI0OS0z/MzY1LmpwZWc.jpeg';
const LABEL_LOGO =
  'https://i.discogs.com/JuO51-lZvasOtw8-yLUjsen-4O17uPH1A9SILCO-lG4/rs:fit/g:sm/q:90/h:300/w:299/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9MLTE4NjYt/MTIzMzE5MzU1Ny5q/cGVn.jpeg';
const APPLE_ARTWORK =
  'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/b6/05/21/b605217c-42ee-8c1e-238b-0fc18570b10d/196873025063.jpg/600x600bb.jpg';
/** Pre-imgproxy Discogs CDN shape: the S3 key sits in the path unencoded. */
const LEGACY_DISCOGS = 'https://img.discogs.com/abc123/R-30797-1493203762-6654.jpeg.jpg';

describe('decodeDiscogsImageKey', () => {
  it('decodes the split base64url blob back to its S3 key', () => {
    expect(decodeDiscogsImageKey(RELEASE_COVER)).toBe('s3://discogs-database-images/R-137129-1222878919.jpeg');
  });

  it('decodes a key whose blob carries a trailing sequence number', () => {
    expect(decodeDiscogsImageKey(ARTIST_IMAGE)).toBe('s3://discogs-database-images/A-3268-1663871249-3365.jpeg');
  });

  it.each([
    ['an Apple mzstatic URL', APPLE_ARTWORK],
    ['a legacy pre-imgproxy Discogs URL', LEGACY_DISCOGS],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('returns null for %s', (_label, url) => {
    expect(decodeDiscogsImageKey(url)).toBeNull();
  });

  it('returns null when the blob decodes to something outside the image bucket', () => {
    // `aHR0cHM6Ly9leGFtcGxlLmNvbQ` -> `https://example.com`, valid base64url
    // that is not an S3 key. A successful decode is not a valid classification.
    expect(decodeDiscogsImageKey('https://i.discogs.com/sig/w:600/aHR0cHM6Ly9leGFt/cGxlLmNvbQ.jpeg')).toBeNull();
  });

  it('returns null when the blob is outside the base64 alphabet (decodes to bytes, not a key)', () => {
    expect(decodeDiscogsImageKey('https://i.discogs.com/sig/w:600/!!!not-base64!!!.jpeg')).toBeNull();
  });
});

describe('classifyArtworkProvenance', () => {
  it.each([
    ['a release cover', RELEASE_COVER, 'release'],
    ['an artist image', ARTIST_IMAGE, 'artist'],
    ['a label logo', LABEL_LOGO, 'label'],
    ['an Apple mzstatic URL', APPLE_ARTWORK, 'unclassified'],
    ['a legacy pre-imgproxy Discogs URL', LEGACY_DISCOGS, 'unclassified'],
    ['null', null, 'unclassified'],
    ['undefined', undefined, 'unclassified'],
  ])('classifies %s as %s', (_label, url, expected) => {
    expect(classifyArtworkProvenance(url)).toBe(expected);
  });

  /**
   * The load-bearing safety property for BS#2258's drain: the selector must be
   * a POSITIVE match on artist/label, never a negative match on "not release".
   * The 191 `album_metadata` + 580 `library` Apple rows are legitimate covers
   * that decode to nothing; a negative-match selector would sweep them all in.
   */
  it('never reports a non-Discogs URL as wrong provenance', () => {
    for (const url of [APPLE_ARTWORK, LEGACY_DISCOGS, 'https://example.com/cover.jpg']) {
      expect(['artist', 'label']).not.toContain(classifyArtworkProvenance(url));
    }
  });
});

describe('isWrongArtworkProvenance', () => {
  it.each([
    ['an artist image', ARTIST_IMAGE, true],
    ['a label logo', LABEL_LOGO, true],
    ['a release cover', RELEASE_COVER, false],
    ['an Apple mzstatic URL', APPLE_ARTWORK, false],
    ['a legacy pre-imgproxy Discogs URL', LEGACY_DISCOGS, false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('reports %s as wrong=%s', (_label, url, expected) => {
    expect(isWrongArtworkProvenance(url)).toBe(expected);
  });
});
