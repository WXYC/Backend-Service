/**
 * Unit tests for the poster render module (BS#3465).
 *
 * Fixtures are generated with sharp at test time; nothing binary is committed.
 */
import sharp from 'sharp';
import {
  MAX_POSTER_BYTES,
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
      ['a 900 px short edge', () => jpeg(900, 1200), 'too_small'],
      ['a 1000 px wide image under the short edge once rotated', () => jpeg(1000, 999), 'too_small'],
      ['a long edge over 6000 px', () => jpeg(1000, 6001), 'too_large'],
      ['an image over 40 megapixels', () => png(8000, 6000), 'too_large'],
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

    it('checks type before decode, decode before animation, and size before aspect', async () => {
      // 900x1920 is both too small and a bad aspect: size is reported first.
      const { bytes, contentType } = await jpeg(900, 1920);
      expect(await renderPoster(bytes, contentType)).toEqual({ ok: false, failure_code: 'too_small' });
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

  describe('normalization', () => {
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
