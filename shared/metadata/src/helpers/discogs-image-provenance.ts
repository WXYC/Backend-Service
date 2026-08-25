/**
 * Decode what a Discogs image URL is actually a picture OF.
 *
 * Discogs serves every image through imgproxy, and the origin S3 key rides
 * along in the URL as a base64url blob **split across `/` path segments**
 * with a `.jpeg` suffix appended:
 *
 *   https://i.discogs.com/<sig>/rs:fit/g:sm/q:90/h:600/w:593/
 *     czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9SLTEzNzEy/OS0xMjIyODc4OTE5/LmpwZWc.jpeg
 *
 * Reassembled and decoded, that is
 * `s3://discogs-database-images/R-137129-1222878919.jpeg`, and the leading
 * letter is the answer:
 *
 *   - `R-` — a **release** cover. What an `artwork_url` is supposed to hold.
 *   - `A-` — an **artist** image. A photo of the band rendered as album art.
 *   - `L-` — a **label** logo. The Warp Records logo rendered as album art.
 *
 * Why this exists (BS#2258): LML's `_resolve_fallback_artwork` cascade walked
 * down to the artist and (historically) label rungs when it could not resolve
 * a real cover, and Backend-Service persisted whatever came back. As of
 * 2026-08-24 that is 6,977 label logos + 973 artist images in
 * `wxyc_schema.album_metadata` and 629 + 1,121 in `wxyc_schema.library`.
 * Nothing in the write path could tell those apart from a cover — the sole
 * content filter is `filterSpacerGif`, which catches Discogs' 1x1 placeholder
 * and nothing else — so the provenance had to be recovered from the stored
 * URL after the fact.
 *
 * **Classify positively, never by exclusion.** `unclassified` is not a
 * synonym for "wrong": Apple `mzstatic` covers (191 rows in `album_metadata`,
 * 580 in `library`) are perfectly good artwork that decodes to nothing at
 * all, as are pre-imgproxy `img.discogs.com` URLs. A selector built on
 * "not `release`" would sweep every one of them into a remediation drain.
 * Callers deciding what to overwrite must match on `artist`/`label`.
 */

/** What a stored `artwork_url` is a picture of, as far as the URL can prove. */
export type ArtworkProvenance = 'release' | 'artist' | 'label' | 'unclassified';

const PROVENANCE_BY_PREFIX: Record<string, ArtworkProvenance> = {
  R: 'release',
  A: 'artist',
  L: 'label',
};

/**
 * The blob is everything after the last imgproxy transform segment. `w:` is
 * used as the anchor rather than a general `key:value` rule because it is
 * last in every one of the 41,333 + 48,431 Discogs-hosted URLs measured
 * across both prod tables on 2026-08-24, and anchoring on a known segment
 * fails closed on an unfamiliar URL shape instead of guessing at one.
 */
const BLOB_AFTER_TRANSFORMS = /\/w:\d+\/(.+)$/;

/** Discogs' image bucket, and the one-letter entity tag that follows it. */
const S3_IMAGE_KEY = /^s3:\/\/discogs-database-images\/([RAL])-/;

/**
 * Recover the origin S3 key from a Discogs imgproxy URL, or `null` when the
 * URL is not one / does not decode to a key in the image bucket.
 *
 * A decode that *succeeds* but yields something outside
 * `s3://discogs-database-images/` is treated as a failure. base64 is
 * permissive enough that an arbitrary path segment can decode to plausible
 * bytes, so "it decoded" is not evidence the split was right — only the
 * bucket prefix is.
 */
export const decodeDiscogsImageKey = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const blob = url.match(BLOB_AFTER_TRANSFORMS)?.[1];
  if (!blob) return null;

  // `Buffer.from(_, 'base64url')` never throws — it skips characters outside
  // the alphabet and returns whatever bytes it assembled. So there is nothing
  // to catch here, and "it decoded" carries no information: the bucket-prefix
  // check below is the only thing standing between garbage and a claim about
  // what an image depicts.
  const reassembled = blob
    .replace(/\.[A-Za-z0-9]+$/, '')
    .split('/')
    .join('');
  const decoded = Buffer.from(reassembled, 'base64url').toString('utf8');
  return S3_IMAGE_KEY.test(decoded) ? decoded : null;
};

/**
 * Classify a stored `artwork_url` by what it depicts. Anything this function
 * cannot prove is `unclassified` — see the module docstring on why that must
 * never be read as "wrong".
 */
export const classifyArtworkProvenance = (url: string | null | undefined): ArtworkProvenance => {
  const key = decodeDiscogsImageKey(url);
  if (!key) return 'unclassified';
  const prefix = key.match(S3_IMAGE_KEY)?.[1];
  return (prefix && PROVENANCE_BY_PREFIX[prefix]) || 'unclassified';
};

/**
 * True when the URL is provably a picture of something other than the
 * release — the positive predicate BS#2258's drain selects on.
 */
export const isWrongArtworkProvenance = (url: string | null | undefined): boolean => {
  const provenance = classifyArtworkProvenance(url);
  return provenance === 'artist' || provenance === 'label';
};
