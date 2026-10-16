import { bitrateKbpsForCodec, MIN_CBR_FRAMES, parseMpegBitrateKbps } from '../../../../jobs/digital-archive-bind/mpeg';

/**
 * Byte-built MPEG audio fixtures, assembled from the spec (ISO 11172-3 /
 * 13818-3) independently of the parser, the same stance as `id3.test.ts`.
 * Each frame is a real Layer III header: sync, version bits, layer bits, no
 * CRC; bitrate index, sample-rate index, padding bit; channel mode. Zero bytes
 * fill it to the spec frame length `floor(samplesPerFrame / 8 * bitrate /
 * sampleRate) + padding`. Each fixture spells out its raw bitrate index next
 * to the kbps the spec table gives for it, so the parser's own table is never
 * the source of an expected value. Each test names the single-line production
 * mutation it exists to catch.
 */
type Version = '1' | '2' | '2.5';

const VERSION_BITS: Record<Version, number> = { '1': 0b11, '2': 0b10, '2.5': 0b00 };
const SAMPLES_PER_FRAME: Record<Version, number> = { '1': 1152, '2': 576, '2.5': 576 };
/** Layer III side-info size, which puts a Xing/Info tag at 4 + this. */
const SIDE_INFO_BYTES: Record<Version, { stereo: number; mono: number }> = {
  '1': { stereo: 32, mono: 17 },
  '2': { stereo: 17, mono: 9 },
  '2.5': { stereo: 17, mono: 9 },
};

interface FrameSpec {
  version: Version;
  /** Raw 4-bit index written into the header. */
  bitrateIndex: number;
  /** What the spec table gives for that index; drives the frame length. */
  kbps: number;
  /** Raw 2-bit index written into the header. */
  rateIndex: number;
  /** What the spec table gives for that index; drives the frame length. */
  sampleRate: number;
  mono?: boolean;
  layerBits?: number;
  /** Explicit length for headers the formula cannot size (free format, bad index). */
  length?: number;
}

const spec = (
  version: Version,
  bitrateIndex: number,
  kbps: number,
  rateIndex: number,
  sampleRate: number,
  extra: Partial<FrameSpec> = {}
): FrameSpec => ({ version, bitrateIndex, kbps, rateIndex, sampleRate, ...extra });

// MPEG-1 index 9 = 128 kbps; rate index 0 = 44.1 kHz, 1 = 48 kHz.
const MPEG1_128_44K = spec('1', 9, 128, 0, 44100);
const MPEG1_128_48K = spec('1', 9, 128, 1, 48000);
const MPEG1_192_44K = spec('1', 11, 192, 0, 44100);
// MPEG-2 index 8 = 64 kbps; rate index 1 = 24 kHz.
const MPEG2_64_24K = spec('2', 8, 64, 1, 24000);
// MPEG-2.5 index 8 = 64 kbps; rate index 0 = 11.025 kHz, 1 = 12 kHz.
const MPEG25_64_11K = spec('2.5', 8, 64, 0, 11025);
const MPEG25_64_12K = spec('2.5', 8, 64, 1, 12000);

const frameLength = (s: FrameSpec, padding: number): number =>
  s.length ?? Math.floor((SAMPLES_PER_FRAME[s.version] * s.kbps * 125) / s.sampleRate) + padding;

/** One zero-filled frame; `body` overwrites bytes from `bodyAt` (e.g. a Xing tag). */
const frame = (s: FrameSpec, padding = 0, body?: Buffer, bodyAt = 0): Buffer => {
  const out = Buffer.alloc(frameLength(s, padding));
  out[0] = 0xff;
  out[1] = 0xe0 | (VERSION_BITS[s.version] << 3) | ((s.layerBits ?? 1) << 1) | 1;
  out[2] = (s.bitrateIndex << 4) | (s.rateIndex << 2) | (padding << 1);
  out[3] = s.mono ? 0b11 << 6 : 0b01 << 6; // single channel, else joint stereo
  body?.copy(out, bodyAt);
  return out;
};

/** `count` contiguous frames; `paddingOf(i)` sets frame i's padding bit, the way an encoder alternates it. */
const stream = (s: FrameSpec, count: number, paddingOf: (i: number) => number = () => 0): Buffer =>
  Buffer.concat(Array.from({ length: count }, (_, i) => frame(s, paddingOf(i))));

/** Cut the last frame in half, as the 256 KB ranged GET does to a real file. */
const asPrefix = (buf: Buffer, s: FrameSpec): Buffer => buf.subarray(0, buf.length - Math.floor(frameLength(s, 0) / 2));

const xingTag = (tag: 'Xing' | 'Info', frames: number | null, bytes: number | null): Buffer => {
  const flags = (frames !== null ? 1 : 0) | (bytes !== null ? 2 : 0);
  const parts = [Buffer.from(tag, 'latin1'), Buffer.alloc(4)];
  parts[1].writeUInt32BE(flags);
  for (const value of [frames, bytes]) {
    if (value !== null) {
      const field = Buffer.alloc(4);
      field.writeUInt32BE(value);
      parts.push(field);
    }
  }
  return Buffer.concat(parts);
};

const xingOffset = (s: FrameSpec): number => 4 + SIDE_INFO_BYTES[s.version][s.mono ? 'mono' : 'stereo'];

/** A Xing-tagged first frame followed by one plain frame. */
const xingFile = (s: FrameSpec, frames: number | null, bytes: number | null): Buffer =>
  Buffer.concat([frame(s, 0, xingTag('Xing', frames, bytes), xingOffset(s)), frame(s)]);

const PLENTY = MIN_CBR_FRAMES + 16;

describe('digital-archive-bind MPEG bitrate parser', () => {
  describe('CBR: a constant run to the end of the prefix', () => {
    it.each([
      // Catches: a hard-coded rate, or indexing the MPEG-1 table off by one.
      ['MPEG-1 128 kbps @ 44.1 kHz', MPEG1_128_44K, () => 0, 128],
      ['MPEG-1 320 kbps @ 44.1 kHz', spec('1', 14, 320, 0, 44100), () => 0, 320],
      ['MPEG-1 192 kbps @ 48 kHz, mono', spec('1', 11, 192, 1, 48000, { mono: true }), () => 0, 192],
      // Catches: dropping `+ padding` from the frame length (every padded frame then points one byte short).
      ['MPEG-1 128 kbps, padding alternating', MPEG1_128_44K, (i: number) => i % 2, 128],
      // Catches: using the MPEG-1 table for every version (index 8 is 112 there, 64 here).
      ['MPEG-2 64 kbps @ 24 kHz', MPEG2_64_24K, () => 0, 64],
      // Catches: reading MPEG-2.5 sample rates from MPEG2_RATES (frame length halves, so the chain never links).
      ['MPEG-2.5 64 kbps @ 11.025 kHz', MPEG25_64_11K, () => 0, 64],
      ['MPEG-2.5 64 kbps @ 11.025 kHz, padding alternating', MPEG25_64_11K, (i: number) => i % 2, 64],
    ])('%s reads as its frame rate', (_name, s, paddingOf, expected) => {
      expect(parseMpegBitrateKbps(asPrefix(stream(s, PLENTY, paddingOf), s))).toBe(expected);
    });

    it.each([
      // Catches: `frames < MIN_CBR_FRAMES` loosened to `<=`.
      [MIN_CBR_FRAMES, 128],
      // Catches: dropping the minimum-run check, so a short chain proves nothing yet still reports CBR.
      [MIN_CBR_FRAMES - 1, null],
    ])('a whole-buffer run of %d frames yields %p', (count, expected) => {
      expect(parseMpegBitrateKbps(stream(MPEG1_128_44K, count))).toBe(expected);
    });

    it('treats an Info tag as CBR and still proves the run constant', () => {
      // Catches: applying the average formula to Info (CBR) tags, whose byte count includes the tag frame.
      const info = frame(MPEG1_128_44K, 0, xingTag('Info', 100, 100000), xingOffset(MPEG1_128_44K));
      expect(parseMpegBitrateKbps(Buffer.concat([info, stream(MPEG1_128_44K, PLENTY)]))).toBe(128);
    });
  });

  describe('fails closed when the rate is not proven constant', () => {
    const mixed = (rates: FrameSpec[]): Buffer => Buffer.concat(rates.map((s) => frame(s)));

    it.each([
      // Catches: returning the first frame's rate when there is no Xing/VBRI header (headerless VBR).
      [
        'headerless VBR (rate changes every frame)',
        mixed(Array.from({ length: PLENTY }, (_, i) => (i % 2 ? MPEG1_192_44K : MPEG1_128_44K))),
      ],
      // Catches: walking only MIN_CBR_FRAMES frames, so a long opening run hides a later change.
      [
        'a long constant run, then a different rate',
        Buffer.concat([stream(MPEG1_128_44K, PLENTY), frame(MPEG1_192_44K), stream(MPEG1_128_44K, 8)]),
      ],
      // Catches: treating a broken chain as the end of the prefix.
      [
        'a constant run broken by junk mid-prefix',
        Buffer.concat([stream(MPEG1_128_44K, PLENTY), Buffer.alloc(600), stream(MPEG1_128_44K, 8)]),
      ],
      // Catches: dropping the sample-rate comparison in the walk.
      [
        'a constant bitrate whose sample rate changes',
        Buffer.concat([stream(MPEG1_128_44K, PLENTY), stream(MPEG1_128_48K, 8)]),
      ],
      // Catches: dropping the table-minimum refusal (VBR encoders write digital silence at the minimum).
      ['an MPEG-1 run at 32 kbps (index 1)', stream(spec('1', 1, 32, 0, 44100), PLENTY)],
      ['an MPEG-2 run at 8 kbps (index 1)', stream(spec('2', 1, 8, 1, 24000), PLENTY)],
      // Catches: dropping the free-format guard (index 0), which makes the frame length 0.
      ['free-format headers (bitrate index 0)', stream(spec('1', 0, 0, 0, 44100, { length: 418 }), PLENTY)],
      // Pins that index 15 never yields a rate. Not a mutation catch: without the guard the NaN frame length also sinks the chain, so the guard is belt-and-braces.
      ['bad-index headers (bitrate index 15)', stream(spec('1', 15, 0, 0, 44100, { length: 418 }), PLENTY)],
      // Catches: dropping the layer check, so Layer I/II tables are read as Layer III.
      ['a Layer II stream', stream(spec('1', 9, 128, 0, 44100, { layerBits: 2 }), PLENTY)],
    ])('%s yields null', (_name, buf) => {
      expect(parseMpegBitrateKbps(buf)).toBeNull();
    });
  });

  describe('VBR: the Xing/VBRI average', () => {
    it.each([
      // 1000 frames * 1152 / 48 kHz = 24 s; 576000 bytes * 8 / 24 s = 192 kbps.
      // Catches: returning the first frame's rate when a Xing tag is present.
      ['MPEG-1 stereo (tag at 36)', MPEG1_128_48K, 1000, 576000, 192],
      // Catches: hard-coding the stereo side-info offset, so a mono file's tag is never found.
      ['MPEG-1 mono (tag at 21)', spec('1', 1, 32, 1, 48000, { mono: true }), 1000, 576000, 192],
      // 1000 frames * 576 / 24 kHz = 24 s; 240000 bytes * 8 / 24 s = 80 kbps.
      // Catches: 1152 samples per frame for MPEG-2 (gives 40), or the MPEG-1 offset for MPEG-2 stereo.
      ['MPEG-2 stereo (tag at 21)', MPEG2_64_24K, 1000, 240000, 80],
      // Catches: the MPEG-2 mono offset (`mono ? 9 : 17`) changed to anything but 9.
      ['MPEG-2 mono (tag at 13)', spec('2', 8, 64, 1, 24000, { mono: true }), 1000, 240000, 80],
      // 1000 frames * 576 / 12 kHz = 48 s; 288000 bytes * 8 / 48 s = 48 kbps.
      // Catches: MPEG-2.5 read with MPEG2_RATES (24 kHz halves the duration: 96).
      ['MPEG-2.5 stereo (tag at 21)', MPEG25_64_12K, 1000, 288000, 48],
    ])('%s reads as the average', (_name, s, frames, bytes, expected) => {
      expect(parseMpegBitrateKbps(xingFile(s, frames, bytes))).toBe(expected);
    });

    it('reads a VBRI header', () => {
      // Catches: ignoring VBRI, which would leave a two-frame run that cannot prove CBR.
      const vbri = Buffer.alloc(26);
      vbri.write('VBRI', 0, 'latin1');
      vbri.writeUInt32BE(576000, 10);
      vbri.writeUInt32BE(1000, 14);
      const buf = Buffer.concat([frame(MPEG1_128_48K, 0, vbri, 36), frame(MPEG1_128_48K)]);
      expect(parseMpegBitrateKbps(buf)).toBe(192);
    });

    it.each([
      // Catches: falling back to the first frame's rate when the average cannot be computed.
      ['a Xing tag missing the frame count', MPEG1_128_48K, null, 576000],
      ['a Xing tag missing the byte count', MPEG1_128_48K, 1000, null],
      // Catches: dropping the upper plausibility bound (1 frame of 10 MB is ~3.3 million kbps).
      ['an MPEG-1 average far above 320', MPEG1_128_48K, 1, 10_000_000],
      // Catches: dropping the lower plausibility bound (rounds to 0 kbps).
      ['an MPEG-1 average below 32', MPEG1_128_48K, 100000, 1000],
      // 24 s, 72000 bytes = 24 kbps: legal for MPEG-2, not MPEG-1. Catches: the MPEG-2 table's bounds for MPEG-1.
      ['an MPEG-1 average of 24', MPEG1_128_48K, 1000, 72000],
      // 24 s, 576000 bytes = 192 kbps: legal for MPEG-1, not MPEG-2. Catches: the MPEG-1 table's bounds for MPEG-2.
      ['an MPEG-2 average of 192', MPEG2_64_24K, 1000, 576000],
    ])('%s yields null', (_name, s, frames, bytes) => {
      expect(parseMpegBitrateKbps(xingFile(s, frames, bytes))).toBeNull();
    });
  });

  it('skips a leading ID3v2 tag, including bytes that look like a sync word', () => {
    // Catches: scanning from byte 0, which would land on the fake frames inside the tag body.
    // The tag body holds two genuine-looking 128 kbps frames (2 * 417 + 166 = 1000 bytes).
    const body = Buffer.concat([frame(MPEG1_128_44K), frame(MPEG1_128_44K), Buffer.alloc(166)]);
    const id3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'latin1'), Buffer.from([0, 0, 7, 104]), body]);
    expect(parseMpegBitrateKbps(Buffer.concat([id3, stream(MPEG1_192_44K, PLENTY)]))).toBe(192);
  });

  it('rejects a lone sync-like header whose successor is not a frame', () => {
    // Catches: accepting the first header-shaped bytes without confirming a second frame follows.
    expect(parseMpegBitrateKbps(Buffer.concat([frame(MPEG1_128_44K), Buffer.alloc(600)]))).toBeNull();
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['three bytes', Buffer.from([0xff, 0xfb, 0x90])],
    ['a buffer truncated inside the first frame', frame(MPEG1_128_44K).subarray(0, 200)],
    ['no frame header at all', Buffer.alloc(4096, 0x41)],
    [
      'an ID3 tag longer than the prefix',
      Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'latin1'), Buffer.from([0, 1, 0, 0]), Buffer.alloc(100)]),
    ],
  ])('returns null for %s', (_name, buf) => {
    // Catches: reading past the buffer, or guessing when no frame is reachable.
    expect(parseMpegBitrateKbps(buf)).toBeNull();
  });

  describe('bitrateKbpsForCodec', () => {
    const mp3Bytes = asPrefix(stream(MPEG1_128_44K, PLENTY), MPEG1_128_44K);

    it('parses an mp3', () => {
      // Catches: the codec gate inverted or comparing against the wrong codec name.
      expect(bitrateKbpsForCodec('mp3', mp3Bytes)).toBe(128);
    });

    it.each(['flac', 'm4a', 'wav', 'aac'])('never consults the parser for %s, even on MPEG-shaped bytes', (codec) => {
      // Catches: dropping the codec gate, so a chance sync in compressed or PCM data stamps an MP3 rate.
      expect(bitrateKbpsForCodec(codec, mp3Bytes)).toBeNull();
    });
  });
});
