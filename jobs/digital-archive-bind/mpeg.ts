/**
 * MPEG Layer III bitrate reader for the `store.ts` 256KB ranged-GET prefix,
 * the sibling of `id3.ts` (BS#2438): skips any leading ID3v2 tag, locates the
 * first frame, and reports `bitrate_kbps` -- the Xing/VBRI average when the
 * file carries one, else the frame rate once the whole prefix proves it
 * constant.
 *
 * Fails closed: anything not provably right inside the bytes read yields
 * `null`, never a guess. A wrong bitrate is worse than a missing one because
 * rendition selection acts on it. A header only counts when a second,
 * matching header sits exactly one frame length later, which rules out
 * sync-like bytes inside tag bodies or cover art. Layer III only; Layer I/II
 * use different tables and are out of scope for this job's mp3 population.
 * Only files classified `mp3` are parsed at all (`bitrateKbpsForCodec`).
 */

import { readSynchsafe } from './id3.js';

const MPEG1_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_RATES = [44100, 48000, 32000];
const MPEG2_RATES = [22050, 24000, 16000];
const MPEG25_RATES = [11025, 12000, 8000];

/**
 * The fewest consecutive frames a headerless stream must show, all at one
 * bitrate, before that bitrate is reported as CBR. 64 frames is about 1.7 s
 * at 44.1/48 kHz (MPEG-1) and 22.05/24 kHz (MPEG-2) -- past an encoder's
 * priming frames -- and costs at most ~67 KB of the prefix at 320 kbps, so a
 * file with a typical embedded cover still qualifies. The walk does not stop
 * at 64: every frame up to the end of the prefix must match (see
 * `constantKbps`).
 */
export const MIN_CBR_FRAMES = 64;

interface FrameHeader {
  kbps: number;
  sampleRate: number;
  mpeg1: boolean;
  mono: boolean;
  length: number;
}

const kbpsTable = (header: FrameHeader): readonly number[] => (header.mpeg1 ? MPEG1_KBPS : MPEG2_KBPS);

const readFrameHeader = (buf: Buffer, at: number): FrameHeader | null => {
  if (at + 4 > buf.length || buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) {
    return null;
  }

  const versionBits = (buf[at + 1] >> 3) & 3; // 0 = MPEG 2.5, 1 = reserved, 2 = MPEG 2, 3 = MPEG 1
  const layerBits = (buf[at + 1] >> 1) & 3; // 1 = Layer III
  const bitrateIndex = buf[at + 2] >> 4;
  const rateIndex = (buf[at + 2] >> 2) & 3;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
    return null;
  }

  const mpeg1 = versionBits === 3;
  const kbps = (mpeg1 ? MPEG1_KBPS : MPEG2_KBPS)[bitrateIndex];
  const sampleRate = (mpeg1 ? MPEG1_RATES : versionBits === 2 ? MPEG2_RATES : MPEG25_RATES)[rateIndex];
  const padding = (buf[at + 2] >> 1) & 1;
  const length = Math.floor(((mpeg1 ? 144000 : 72000) * kbps) / sampleRate) + padding;
  return { kbps, sampleRate, mpeg1, mono: buf[at + 3] >> 6 === 3, length };
};

/** Where audio starts: past a leading ID3v2 tag (and footer), or 0 when there is none. */
const audioStart = (buf: Buffer): number => {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') {
    return 0;
  }
  return 10 + readSynchsafe(buf, 6) + (buf[5] & 0x10 ? 10 : 0);
};

/**
 * Average bitrate from a Xing/VBRI header in the first frame. `undefined`
 * when there is no VBR header; `null` when one is present but incomplete, or
 * when its average falls outside the version's Layer III bitrate table (a
 * corrupt or mismatched frame/byte count).
 */
const vbrAverageKbps = (buf: Buffer, at: number, header: FrameHeader): number | null | undefined => {
  const xingAt = at + 4 + (header.mpeg1 ? (header.mono ? 17 : 32) : header.mono ? 9 : 17);
  const tag = buf.toString('latin1', xingAt, xingAt + 4);
  const vbri = buf.toString('latin1', at + 36, at + 40) === 'VBRI';
  if (tag !== 'Xing' && !vbri) {
    return undefined; // no VBR header (an `Info` tag marks CBR): the frame rate must prove itself constant
  }

  let frames: number;
  let bytes: number;
  if (vbri) {
    if (at + 54 > buf.length) {
      return null;
    }
    bytes = buf.readUInt32BE(at + 46);
    frames = buf.readUInt32BE(at + 50);
  } else {
    if (xingAt + 16 > buf.length || (buf.readUInt32BE(xingAt + 4) & 3) !== 3) {
      return null;
    }
    frames = buf.readUInt32BE(xingAt + 8);
    bytes = buf.readUInt32BE(xingAt + 12);
  }
  if (frames === 0 || bytes === 0) {
    return null;
  }

  const seconds = (frames * (header.mpeg1 ? 1152 : 576)) / header.sampleRate;
  const average = Math.round((bytes * 8) / seconds / 1000);
  const table = kbpsTable(header);
  if (average < table[1] || average > table[table.length - 1]) {
    return null;
  }
  return average;
};

/**
 * The first frame's bitrate, but only when the stream proves it constant:
 * every frame from `at` to the end of the prefix must be a valid header with
 * the same version, sample rate and bitrate, contiguous (no gap or junk), and
 * there must be at least `MIN_CBR_FRAMES` of them. The last frame may be cut
 * off by the end of the prefix. A run at the table's minimum bitrate (32 kbps
 * MPEG-1, 8 kbps MPEG-2/2.5) is also refused: that is the rate VBR encoders
 * write for digital silence, so a headerless VBR file opening on silence
 * would otherwise pass as CBR.
 *
 * Residual case: a headerless VBR file whose entire prefix shares one
 * non-minimum rate (dense material saturating at 320, or a forced-bitrate
 * intro) is indistinguishable from CBR and is reported as that rate.
 */
const constantKbps = (buf: Buffer, at: number, first: FrameHeader): number | null => {
  let frames = 0;
  for (let pos = at; pos + 4 <= buf.length;) {
    const header = readFrameHeader(buf, pos);
    if (
      !header ||
      header.kbps !== first.kbps ||
      header.sampleRate !== first.sampleRate ||
      header.mpeg1 !== first.mpeg1
    ) {
      return null;
    }
    frames++;
    pos += header.length;
  }

  if (frames < MIN_CBR_FRAMES || first.kbps === kbpsTable(first)[1]) {
    return null;
  }
  return first.kbps;
};

export const parseMpegBitrateKbps = (buf: Buffer): number | null => {
  for (let at = audioStart(buf); at + 4 <= buf.length; at++) {
    const header = readFrameHeader(buf, at);
    const next = header && readFrameHeader(buf, at + header.length);
    if (!header || !next || next.sampleRate !== header.sampleRate || next.mpeg1 !== header.mpeg1) {
      continue;
    }

    const average = vbrAverageKbps(buf, at, header);
    return average === undefined ? constantKbps(buf, at, header) : average;
  }
  return null;
};

/**
 * `bitrate_kbps` for one classified file: the MPEG parse for `mp3`, `null`
 * for every other codec. The parser is never run on flac/m4a/wav/aac bytes,
 * so a chance sync inside compressed or PCM data cannot stamp an MP3 frame
 * rate onto a non-mp3 row.
 */
export const bitrateKbpsForCodec = (codec: string, buf: Buffer): number | null =>
  codec === 'mp3' ? parseMpegBitrateKbps(buf) : null;
