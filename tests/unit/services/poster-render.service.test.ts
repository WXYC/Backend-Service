/**
 * Unit tests for the poster render module (BS#3465).
 *
 * Fixtures are generated with sharp at test time; nothing binary is committed.
 */
import sharp from 'sharp';
import {
  MAX_POSTER_BYTES,
  POSTER_RULES,
  renderPoster,
  type PosterFailureCode,
  type PosterRenderResult,
} from '../../../apps/backend/services/poster-render.service';

type Fixture = { bytes: Buffer; contentType: string };

const solid = (width: number, height: number, background = '#c33') =>
  sharp({ create: { width, height, channels: 3, background } });

const jpeg = async (width: number, height: number): Promise<Fixture> => ({
  bytes: await solid(width, height).jpeg().toBuffer(),
  contentType: 'image/jpeg',
});
const png = async (width: number, height: number): Promise<Fixture> => ({
  bytes: await solid(width, height).png().toBuffer(),
  contentType: 'image/png',
});
const webp = async (width: number, height: number): Promise<Fixture> => ({
  bytes: await solid(width, height).webp().toBuffer(),
  contentType: 'image/webp',
});

const animatedWebp = async (): Promise<Fixture> => {
  const frames = await Promise.all(['#f00', '#00f'].map((c) => solid(1080, 1350, c).png().toBuffer()));
  return {
    bytes: await sharp(frames, { join: { animated: true } })
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer(),
    contentType: 'image/webp',
  };
};

// An APNG is a PNG with an acTL chunk ahead of the first IDAT; sharp reports no `pages` for it.
const crc32 = (buf: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const animatedPng = async (): Promise<Fixture> => {
  const still = (await png(1080, 1350)).bytes;
  const data = Buffer.alloc(8);
  data.writeUInt32BE(2, 0); // num_frames
  const type = Buffer.from('acTL');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  const idat = still.indexOf('IDAT') - 4;
  return {
    bytes: Buffer.concat([still.subarray(0, idat), length, type, data, crc, still.subarray(idat)]),
    contentType: 'image/png',
  };
};

const gif = async (): Promise<Fixture> => ({
  bytes: await solid(1080, 1350).gif().toBuffer(),
  contentType: 'image/gif',
});

// The tests tsconfig is not strict, so the union does not narrow on `ok`; assert and cast instead.
const renderOk = async (bytes: Buffer, contentType: string) => {
  const result = await renderPoster(bytes, contentType);
  expect(result).toMatchObject({ ok: true });
  return result as Extract<PosterRenderResult, { ok: true }>;
};

describe('renderPoster', () => {
  describe('refusals', () => {
    const cases: Array<[string, () => Promise<Fixture>, PosterFailureCode]> = [
      ['a GIF', gif, 'unsupported_type'],
      [
        'an SVG declared type',
        () => Promise.resolve({ bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml' }),
        'unsupported_type',
      ],
      [
        'a HEIC declared type',
        () => Promise.resolve({ bytes: Buffer.from('x'), contentType: 'image/heic' }),
        'unsupported_type',
      ],
      ['a GIF declared as JPEG', async () => ({ ...(await gif()), contentType: 'image/jpeg' }), 'unsupported_type'],
      [
        'garbage bytes',
        () => Promise.resolve({ bytes: Buffer.from('not an image'), contentType: 'image/jpeg' }),
        'decode_failed',
      ],
      [
        'a PNG declared as JPEG',
        async () => ({ ...(await png(1080, 1350)), contentType: 'image/jpeg' }),
        'decode_failed',
      ],
      ['an animated WebP', animatedWebp, 'animated'],
      ['an animated PNG', animatedPng, 'animated'],
      ['a 900 px short edge', () => jpeg(900, 1200), 'too_small'],
      ['a 1000x999 image', () => jpeg(1000, 999), 'too_small'],
      ['a long edge over 6000 px', () => jpeg(1000, 6001), 'too_large'],
      [
        'a file over 10 MB',
        async () => ({
          bytes: Buffer.concat([(await jpeg(1080, 1350)).bytes, Buffer.alloc(MAX_POSTER_BYTES)]),
          contentType: 'image/jpeg',
        }),
        'too_large',
      ],
      ['a 9:16 story', () => jpeg(1080, 1920), 'bad_aspect'],
      ['landscape art', () => jpeg(1920, 1080), 'bad_aspect'],
      ['a barely landscape image', () => jpeg(1001, 1000), 'bad_aspect'],
    ];

    it.each(cases)('%s -> %s', async (_name, build, failureCode) => {
      const { bytes, contentType } = await build();
      expect(await renderPoster(bytes, contentType)).toEqual({ ok: false, failure_code: failureCode });
    });

    it('reports too_small before bad_aspect', async () => {
      // 900x1920 is both too small and a bad aspect.
      const { bytes, contentType } = await jpeg(900, 1920);
      expect(await renderPoster(bytes, contentType)).toEqual({ ok: false, failure_code: 'too_small' });
    });

    it('reports too_large before too_small', async () => {
      // 500x6001 is both over the long edge and under the short edge.
      const { bytes, contentType } = await jpeg(500, 6001);
      expect(await renderPoster(bytes, contentType)).toEqual({ ok: false, failure_code: 'too_large' });
    });

    it('reports animated before size', async () => {
      const frames = await Promise.all(['#f00', '#00f'].map((c) => solid(500, 500, c).png().toBuffer()));
      const bytes = await sharp(frames, { join: { animated: true } })
        .webp({ delay: [100, 100], loop: 0 })
        .toBuffer();
      expect(await renderPoster(bytes, 'image/webp')).toEqual({ ok: false, failure_code: 'animated' });
    });

    it('reports the declared type before decoding the bytes', async () => {
      expect(await renderPoster(Buffer.from('not an image'), 'image/gif')).toEqual({
        ok: false,
        failure_code: 'unsupported_type',
      });
    });

    it('judges size and aspect after EXIF rotation', async () => {
      // Stored 1200x900 (landscape) with orientation 6 displays as 900x1200: too_small, not bad_aspect.
      const bytes = await solid(1200, 900).jpeg().withMetadata({ orientation: 6 }).toBuffer();
      expect(await renderPoster(bytes, 'image/jpeg')).toEqual({ ok: false, failure_code: 'too_small' });
    });

    it('refuses an over-40-megapixel image on the pixel cap alone', async () => {
      // POSTER_RULES cannot reach the cap (6000x6000 is 36 MP), so loosen the edge limit: 10000x5000 is 50 MP.
      const { bytes, contentType } = await png(10000, 5000);
      const rules = { ...POSTER_RULES, maxLongEdge: 12000 };
      expect(await renderPoster(bytes, contentType, rules)).toEqual({ ok: false, failure_code: 'too_large' });
    });
  });

  describe('acceptance and renditions', () => {
    const cases: Array<[string, () => Promise<Fixture>, number, number, number[]]> = [
      ['1080x1350 JPEG', () => jpeg(1080, 1350), 1080, 1350, [600, 1080]],
      ['1080x1080 PNG', () => png(1080, 1080), 1080, 1080, [600, 1080]],
      ['2:3 WebP', () => webp(1200, 1800), 1200, 1800, [600, 1200]],
      ['a 4000x6000 JPEG', () => jpeg(4000, 6000), 4000, 6000, [600, 1200]],
    ];

    it.each(cases)(
      '%s renders ascending, never-upscaled JPEG renditions',
      async (_name, build, sourceWidth, sourceHeight, widths) => {
        const { bytes, contentType } = await build();
        const result = await renderOk(bytes, contentType);

        expect(result.renditions.map((r) => r.width)).toEqual(widths);
        expect(result.aspect_ratio).toBeCloseTo(sourceWidth / sourceHeight, 5);
        for (const rendition of result.renditions) {
          const meta = await sharp(rendition.bytes).metadata();
          expect(meta.format).toBe('jpeg');
          expect(meta.space).toBe('srgb');
          expect(meta.width).toBe(rendition.width);
          expect(meta.height).toBe(rendition.height);
          expect(rendition.height / rendition.width).toBeCloseTo(sourceHeight / sourceWidth, 2);
        }
      }
    );
  });

  describe('declared content type', () => {
    it.each(['IMAGE/JPEG', 'image/jpeg; charset=binary', ' Image/Jpeg ;q=1'])('accepts %s', async (declared) => {
      const { bytes } = await jpeg(1080, 1350);
      await renderOk(bytes, declared);
    });
  });

  describe('normalization', () => {
    it('flattens transparency onto white, not black', async () => {
      const bytes = await sharp({
        create: { width: 1080, height: 1350, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer();
      const result = await renderOk(bytes, 'image/png');
      for (const rendition of result.renditions) {
        const { data, info } = await sharp(rendition.bytes).raw().toBuffer({ resolveWithObject: true });
        const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
        expect([...data.subarray(mid, mid + 3)].every((v) => v >= 250)).toBe(true);
      }
    });

    it('applies EXIF orientation and strips all metadata', async () => {
      // Stored landscape (red left, blue right) with orientation 6 (rotate 90 deg CW): upright is portrait, red on top.
      const left = await solid(675, 1080, '#f00').png().toBuffer();
      const right = await solid(675, 1080, '#00f').png().toBuffer();
      const stored = await sharp({ create: { width: 1350, height: 1080, channels: 3, background: '#000' } })
        .composite([
          { input: left, left: 0, top: 0 },
          { input: right, left: 675, top: 0 },
        ])
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
      expect((await sharp(stored).metadata()).exif).toBeDefined();

      const result = await renderOk(stored, 'image/jpeg');

      const large = result.renditions[1];
      expect([large.width, large.height]).toEqual([1080, 1350]);
      const meta = await sharp(large.bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      const { data, info } = await sharp(large.bytes).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => data.subarray((y * info.width + x) * info.channels).subarray(0, 3);
      expect(pixel(540, 20)[0]).toBeGreaterThan(200);
      expect(pixel(540, 1330)[2]).toBeGreaterThan(200);
    });
  });

  describe('resource limits', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('decodes one image at a time', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const real = sharp.prototype.toBuffer;
      jest.spyOn(sharp.prototype, 'toBuffer').mockImplementation(function (this: unknown, ...args: unknown[]) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return (real as (...a: unknown[]) => Promise<unknown>).apply(this, args).finally(() => {
          inFlight -= 1;
        }) as never;
      });

      const { bytes, contentType } = await jpeg(1080, 1350);
      const results = await Promise.all([1, 2, 3].map(() => renderPoster(bytes, contentType)));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(maxInFlight).toBe(1);
    });

    it('releases the lock after a failed render', async () => {
      const { bytes, contentType } = await jpeg(1080, 1350);
      const [bad, good] = await Promise.all([
        renderPoster(Buffer.from('nope'), contentType),
        renderPoster(bytes, contentType),
      ]);

      expect(bad).toEqual({ ok: false, failure_code: 'decode_failed' });
      expect(good.ok).toBe(true);
    });

    it('reports sharp timing out as a timeout failure', async () => {
      const { bytes, contentType } = await jpeg(1080, 1350);
      jest
        .spyOn(sharp.prototype, 'toBuffer')
        .mockRejectedValueOnce(new Error('timeout: 0% complete\nVipsImage: killed for image "temp-1"'));

      expect(await renderPoster(bytes, contentType)).toEqual({ ok: false, failure_code: 'timeout' });
    });
  });
});
