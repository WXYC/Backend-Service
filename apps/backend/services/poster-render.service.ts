/**
 * Poster render module (BS#3465): validates an uploaded poster and renders the
 * normalized renditions listener surfaces show. Pure sharp, no S3 or database
 * access, so callers own storage and the mapping of `failure_code` to a response.
 *
 * Renditions are JPEG (q85, sRGB, EXIF-rotated, all metadata stripped) at the
 * poster's own aspect ratio: never upscaled, cropped, or padded.
 */

import sharp from 'sharp';

/** Largest accepted upload, in bytes. */
export const MAX_POSTER_BYTES = 10 * 1024 * 1024;

/** Input pixel cap (40 megapixels); sharp enforces it as `limitInputPixels` too. */
const MAX_INPUT_PIXELS = 40_000_000;

/** Wall-clock budget per call, in milliseconds, counted from when the call takes the lock. */
const RENDER_BUDGET_MS = 30_000;

const JPEG_QUALITY = 85;

/** Declared content type -> the format sharp must detect in the bytes. */
const ACCEPTED_FORMATS: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

export type PosterFailureCode =
  'unsupported_type' | 'decode_failed' | 'animated' | 'too_large' | 'too_small' | 'bad_aspect' | 'timeout';

export interface PosterRendition {
  width: number;
  height: number;
  bytes: Buffer;
}

export type PosterRenderResult =
  { ok: true; renditions: PosterRendition[]; aspect_ratio: number } | { ok: false; failure_code: PosterFailureCode };

/** Per-asset-kind rules; a later caller (logos) supplies its own without touching the pipeline. */
export interface RenderRules {
  /** Smallest allowed short edge, in pixels. */
  minShortEdge: number;
  /** Largest allowed long edge, in pixels. */
  maxLongEdge: number;
  /** Inclusive bounds on width / height. */
  minAspect: number;
  maxAspect: number;
  /** Rendition widths in pixels, ascending; each is capped at the source width. */
  widths: readonly number[];
}

export const POSTER_RULES: RenderRules = {
  minShortEdge: 1000,
  maxLongEdge: 6000,
  minAspect: 2 / 3,
  maxAspect: 1,
  widths: [600, 1200],
};

// Serializes renders so at most one image is decoded at a time.
let queueTail: Promise<unknown> = Promise.resolve();

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task);
  queueTail = run.catch(() => undefined);
  return run;
}

const fail = (failure_code: PosterFailureCode): PosterRenderResult => ({ ok: false, failure_code });

/**
 * Validates `bytes` and renders its renditions. Calls queue behind an in-process
 * lock; a render that outlives its 30 s budget returns `timeout`.
 *
 * Checks run in this order and the first failure wins: type (declared content
 * type, then the format detected in the bytes), decode, animation, size
 * (`too_large` before `too_small`), aspect. Orientation is applied before the
 * edge and aspect checks, so a phone photo is judged as it displays.
 *
 * @param bytes - The uploaded file.
 * @param contentType - The declared content type (image/jpeg, image/png, image/webp).
 * @param rules - Dimension rules and rendition widths; defaults to the poster rules.
 */
export function renderPoster(
  bytes: Buffer,
  contentType: string,
  rules: RenderRules = POSTER_RULES
): Promise<PosterRenderResult> {
  const declared = ACCEPTED_FORMATS[contentType];
  if (!declared) {
    return Promise.resolve(fail('unsupported_type'));
  }
  return withLock(async () => {
    const deadline = Date.now() + RENDER_BUDGET_MS;
    try {
      const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
      if (!meta.format || !meta.width || !meta.height) {
        return fail('decode_failed');
      }
      if (!Object.values(ACCEPTED_FORMATS).includes(meta.format)) {
        return fail('unsupported_type');
      }
      if (meta.format !== declared) {
        return fail('decode_failed');
      }
      if ((meta.pages ?? 1) > 1) {
        return fail('animated');
      }

      const swapped = (meta.orientation ?? 1) >= 5;
      const width = swapped ? meta.height : meta.width;
      const height = swapped ? meta.width : meta.height;
      if (
        bytes.length > MAX_POSTER_BYTES ||
        width * height > MAX_INPUT_PIXELS ||
        Math.max(width, height) > rules.maxLongEdge
      ) {
        return fail('too_large');
      }
      if (Math.min(width, height) < rules.minShortEdge) {
        return fail('too_small');
      }
      if (width / height < rules.minAspect || width / height > rules.maxAspect) {
        return fail('bad_aspect');
      }

      const renditions: PosterRendition[] = [];
      for (const target of rules.widths) {
        const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
          .timeout({ seconds })
          .rotate()
          .resize({ width: target, withoutEnlargement: true })
          .toColourspace('srgb')
          .jpeg({ quality: JPEG_QUALITY })
          .toBuffer({ resolveWithObject: true });
        renditions.push({ width: info.width, height: info.height, bytes: data });
      }
      return { ok: true, renditions, aspect_ratio: width / height };
    } catch (err) {
      return fail(err instanceof Error && err.message.startsWith('timeout') ? 'timeout' : 'decode_failed');
    }
  });
}
