/**
 * Minimal ID3v2 tag parser (BS#2319 "no-key fallback"): reads the leading
 * bytes of a `store.ts` 256KB ranged GET and extracts the seven frames the
 * job needs -- TIT2/TPE1/TALB/TPE2/TRCK/TPOS/TLEN -- without pulling in a
 * third-party ID3 library.
 *
 * Scope is ID3v2.3 and ID3v2.4 (4-byte frame IDs, matching the frame names
 * the issue names verbatim). ID3v2.2 (3-byte IDs like TT2) is out of scope
 * -- unrecognized major versions degrade to all-null tags rather than
 * throwing, since a file this job can't tag-read is simply reported
 * unmatched, not a crash.
 *
 * Total over its input by construction: every read is bounds-checked
 * against the buffer length, so a 256KB-truncated ranged GET (a tag whose
 * declared size exceeds what was fetched) yields whatever frames fit in the
 * bytes actually read rather than throwing.
 */

export interface Id3Tags {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
}

const emptyTags = (): Id3Tags => ({
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  track: null,
  disc: null,
  durationMs: null,
});

/** Frame IDs this job reads, mapped to their `Id3Tags` field. */
const WANTED_FRAMES: Readonly<Record<string, keyof Id3Tags>> = {
  TIT2: 'title',
  TPE1: 'artist',
  TALB: 'album',
  TPE2: 'albumArtist',
  TRCK: 'track',
  TPOS: 'disc',
  TLEN: 'durationMs',
};

const NUMERIC_FIELDS = new Set<keyof Id3Tags>(['track', 'disc', 'durationMs']);

const FRAME_ID_PATTERN = /^[A-Z0-9]{4}$/;

const readSynchsafe = (buf: Buffer, offset: number): number =>
  ((buf[offset] & 0x7f) << 21) |
  ((buf[offset + 1] & 0x7f) << 14) |
  ((buf[offset + 2] & 0x7f) << 7) |
  (buf[offset + 3] & 0x7f);

/** v2.3 frame sizes are plain big-endian; v2.4 frame sizes are synchsafe. */
const readFrameSize = (buf: Buffer, offset: number, major: number): number =>
  major >= 4 ? readSynchsafe(buf, offset) : buf.readUInt32BE(offset);

const swapUtf16 = (buf: Buffer): Buffer => {
  const evenLength = buf.length - (buf.length % 2);
  const out = Buffer.alloc(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
};

/**
 * Decode a text-information frame body: leading encoding byte (0 latin1, 1
 * UTF-16 with BOM, 2 UTF-16BE without BOM, 3 UTF-8), trailing NUL padding
 * and whitespace stripped.
 */
const decodeTextFrame = (body: Buffer): string => {
  if (body.length === 0) return '';
  const encoding = body[0];
  const raw = body.subarray(1);

  let text: string;
  switch (encoding) {
    case 0x01: {
      // UTF-16 with a leading BOM. A BE BOM (0xFE 0xFF) needs a byte swap
      // first -- Node has no native "utf16be" decoder.
      const hasBeBom = raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff;
      const withoutBom = raw.length >= 2 ? raw.subarray(2) : raw;
      text = (hasBeBom ? swapUtf16(withoutBom) : withoutBom).toString('utf16le');
      break;
    }
    case 0x02:
      text = swapUtf16(raw).toString('utf16le');
      break;
    case 0x03:
      text = raw.toString('utf8');
      break;
    case 0x00:
    default:
      text = raw.toString('latin1');
      break;
  }

  return stripTrailingNul(text).trim();
};

/**
 * Trailing NUL padding is part of the ID3v2 text-frame spec, not stray
 * whitespace -- `Buffer#toString` does not stop at a NUL byte the way a C
 * string would, so the padding survives decode and has to be stripped
 * explicitly. Character-code comparison rather than a regex literal
 * containing a NUL byte, which editor/transport tooling has a habit of
 * mangling silently.
 */
const NUL_CHAR_CODE = 0;

const stripTrailingNul = (text: string): string => {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === NUL_CHAR_CODE) end--;
  return text.slice(0, end);
};

/** TRCK/TPOS are "N" or "N/M"; TLEN is a plain millisecond count. */
const parseLeadingInt = (text: string): number | null => {
  const match = /^\s*(\d+)/.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
};

export const parseId3v2 = (buf: Buffer): Id3Tags => {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return emptyTags();

  const major = buf[3];
  if (major !== 3 && major !== 4) return emptyTags();

  const flags = buf[5];
  const tagSize = readSynchsafe(buf, 6);
  const tagEnd = Math.min(buf.length, 10 + tagSize);

  let offset = 10;

  // Extended header (flag bit 0x40): skip it. v2.3's size field excludes
  // itself; v2.4's includes itself -- best-effort, since no fixture in
  // this job's population is known to carry one.
  if (flags & 0x40) {
    if (offset + 4 > buf.length) return emptyTags();
    const extSize = major === 4 ? readSynchsafe(buf, offset) : buf.readUInt32BE(offset);
    offset += major === 4 ? extSize : 4 + extSize;
  }

  const tags = emptyTags();

  while (offset + 10 <= tagEnd && offset + 10 <= buf.length) {
    const frameId = buf.toString('latin1', offset, offset + 4);
    if (!FRAME_ID_PATTERN.test(frameId)) break; // padding, or not a frame at all

    const frameSize = readFrameSize(buf, offset + 4, major);
    const bodyStart = offset + 10;
    if (bodyStart >= buf.length) break; // nothing left to read

    const bodyEnd = Math.min(buf.length, bodyStart + frameSize);
    const truncated = bodyEnd - bodyStart < frameSize;

    const field = WANTED_FRAMES[frameId];
    // A frame whose body the ranged GET cut short is DROPPED, never
    // half-decoded. Assigning the partial text would put a silently wrong
    // value into grouping and fuzzy matching -- "Artist Whose Tag Overruns"
    // arriving as "Art" would split an album across two groups, or match the
    // wrong library row, with nothing to indicate it happened. A null is
    // merely `ungroupable`, which the report surfaces. Fail closed.
    if (field && !truncated) {
      const text = decodeTextFrame(buf.subarray(bodyStart, bodyEnd));
      if (text.length > 0) {
        if (NUMERIC_FIELDS.has(field)) {
          const parsed = parseLeadingInt(text);
          if (parsed !== null) (tags as unknown as Record<string, number>)[field] = parsed;
        } else {
          (tags as unknown as Record<string, string>)[field] = text;
        }
      }
    }

    if (truncated) break; // this was the last frame the ranged GET could reach
    offset = bodyEnd;
  }

  return tags;
};
