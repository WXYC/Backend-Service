import { parseId3v2 } from '../../../../jobs/digital-archive-bind/id3';

/**
 * Checked-in ID3v2.3 fixture headers, hand-built as explicit byte sequences
 * below rather than as binary blobs under `fixtures/` — a raw binary fixture
 * reviews as an opaque diff on GitHub, where this builder's output is
 * auditable byte-for-byte in the PR. `buildId3v2` is deliberately a
 * minimal, independent encoder (not a call into `parseId3v2`'s own code) so
 * the test can't pass by construction.
 */
const synchsafe = (size: number): Buffer => {
  const out = Buffer.alloc(4);
  out[0] = (size >>> 21) & 0x7f;
  out[1] = (size >>> 14) & 0x7f;
  out[2] = (size >>> 7) & 0x7f;
  out[3] = size & 0x7f;
  return out;
};

const textFrame = (id: string, text: string, encoding = 0x00): Buffer => {
  const body = Buffer.concat([Buffer.from([encoding]), Buffer.from(text, 'latin1')]);
  const header = Buffer.concat([Buffer.from(id, 'latin1'), Buffer.alloc(4), Buffer.alloc(2)]);
  header.writeUInt32BE(body.length, 4); // v2.3 frame size is plain big-endian, not synchsafe
  return Buffer.concat([header, body]);
};

const buildId3v2 = (frames: Buffer[]): Buffer => {
  const frameBytes = Buffer.concat(frames);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00, 0x00]),
    synchsafe(frameBytes.length),
  ]);
  return Buffer.concat([header, frameBytes]);
};

describe('digital-archive-bind ID3v2 parser', () => {
  it('parses a full-tag file (BS#2319 AC fixture 1)', () => {
    const buf = buildId3v2([
      textFrame('TIT2', 'Off the Record'),
      textFrame('TPE1', 'Roméo Poirier'),
      textFrame('TALB', 'Living Room Session'),
      textFrame('TPE2', 'Roméo Poirier'),
      textFrame('TRCK', '3/12'),
      textFrame('TPOS', '1/1'),
      textFrame('TLEN', '245000'),
    ]);

    expect(parseId3v2(buf)).toEqual({
      title: 'Off the Record',
      artist: 'Roméo Poirier',
      album: 'Living Room Session',
      albumArtist: 'Roméo Poirier',
      track: 3,
      disc: 1,
      durationMs: 245000,
    });
  });

  it('parses a no-track-number file (BS#2319 AC fixture 2)', () => {
    const buf = buildId3v2([
      textFrame('TIT2', 'Take a Number'),
      textFrame('TPE1', 'Heavy Rotation Artist'),
      textFrame('TALB', 'Heavy'),
    ]);

    const tags = parseId3v2(buf);
    expect(tags.title).toBe('Take a Number');
    expect(tags.artist).toBe('Heavy Rotation Artist');
    expect(tags.album).toBe('Heavy');
    expect(tags.track).toBeNull();
    expect(tags.disc).toBeNull();
  });

  it('parses a TPOS disc file (BS#2319 AC fixture 3)', () => {
    const buf = buildId3v2([
      textFrame('TIT2', 'Side B, Track 1'),
      textFrame('TPE1', 'Duke Ellington & John Coltrane'),
      textFrame('TALB', 'Duke Ellington & John Coltrane'),
      textFrame('TPOS', '2/2'),
    ]);

    expect(parseId3v2(buf).disc).toBe(2);
  });

  it('returns all-null tags for a buffer with no ID3 header', () => {
    const buf = Buffer.from('not an id3 tag at all', 'latin1');
    expect(parseId3v2(buf)).toEqual({
      title: null,
      artist: null,
      album: null,
      albumArtist: null,
      track: null,
      disc: null,
      durationMs: null,
    });
  });

  it('is total over a buffer cut before any frame header is readable', () => {
    const full = buildId3v2([textFrame('TIT2', 'Truncated'), textFrame('TPE1', 'Artist Whose Tag Overruns')]);
    const truncated = full.subarray(0, 12); // header + a sliver of the first frame header
    expect(() => parseId3v2(truncated)).not.toThrow();
    expect(parseId3v2(truncated).title).toBeNull();
  });

  it('recovers whole frames when the buffer is cut MID-BODY (the 256KB ranged-GET boundary)', () => {
    // The case the ranged GET actually produces: a complete first frame, then
    // a second whose header parses but whose body runs past the end of what
    // we fetched. Cutting at 12 bytes (above) never enters the frame loop at
    // all -- `offset + 10 <= tagEnd` is false on the first iteration -- so it
    // exercises none of the truncation handling it appears to name.
    const full = buildId3v2([textFrame('TIT2', 'Complete Title'), textFrame('TPE1', 'Artist Whose Tag Overruns')]);
    const firstFrameEnd = 10 + 10 + Buffer.byteLength('Complete Title', 'latin1') + 1;
    const midSecondBody = full.subarray(0, firstFrameEnd + 10 + 4);

    expect(() => parseId3v2(midSecondBody)).not.toThrow();
    const tags = parseId3v2(midSecondBody);
    expect(tags.title).toBe('Complete Title'); // the frame that fully arrived survives
    expect(tags.artist).toBeNull(); // the one cut mid-body is dropped, not half-decoded
  });

  it('decodes a UTF-16 (BOM) text frame', () => {
    const text = 'Chuquimamani-Condori';
    const utf16 = Buffer.from(text, 'utf16le');
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.concat([Buffer.from([0x01]), bom, utf16]);
    const header = Buffer.concat([Buffer.from('TPE1', 'latin1'), Buffer.alloc(4), Buffer.alloc(2)]);
    header.writeUInt32BE(body.length, 4);
    const buf = buildId3v2([Buffer.concat([header, body])]);
    expect(parseId3v2(buf).artist).toBe(text);
  });

  it('strips trailing NUL padding from a text frame', () => {
    const header = Buffer.concat([Buffer.from('TALB', 'latin1'), Buffer.alloc(4), Buffer.alloc(2)]);
    const body = Buffer.concat([Buffer.from([0x00]), Buffer.from('Padded Album\0\0\0', 'latin1')]);
    header.writeUInt32BE(body.length, 4);
    const buf = buildId3v2([Buffer.concat([header, body])]);
    expect(parseId3v2(buf).album).toBe('Padded Album');
  });
});
