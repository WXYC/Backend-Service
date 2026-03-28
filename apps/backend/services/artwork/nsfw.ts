/**
 * NSFW artwork classifier using nsfwjs (TensorFlow.js).
 *
 * Loads the Yahoo OpenNSFW model once at startup and classifies images
 * by their probability of containing NSFW content. Uses the same model
 * and threshold as the iOS app's CoreML-based classifier for parity.
 */

import * as nsfwjs from 'nsfwjs';
import * as tf from '@tensorflow/tfjs-node';

/** Classification result: safe for work or not. */
export type NSFWResult = 'sfw' | 'nsfw';

/** Threshold above which an image is considered NSFW (matches iOS app). */
const NSFW_THRESHOLD = 0.5;

/** Singleton model instance, loaded lazily on first classify() call. */
let model: nsfwjs.NSFWJS | null = null;
let modelLoading: Promise<nsfwjs.NSFWJS> | null = null;

/**
 * Loads the NSFW model (singleton, thread-safe via promise dedup).
 */
async function getModel(): Promise<nsfwjs.NSFWJS> {
  if (model) return model;
  if (modelLoading) return modelLoading;

  modelLoading = nsfwjs.load().then((m) => {
    model = m;
    console.log('[NSFWClassifier] Model loaded');
    return m;
  });

  return modelLoading;
}

/**
 * Classifies an image buffer as SFW or NSFW.
 *
 * @param imageBuffer - Raw image bytes (JPEG, PNG, WebP, etc.)
 * @returns 'sfw' or 'nsfw'
 */
export async function classify(imageBuffer: Buffer): Promise<NSFWResult> {
  const nsfwModel = await getModel();

  // Decode image to a 3-channel tensor
  const tensor = tf.node.decodeImage(imageBuffer, 3) as tf.Tensor3D;

  try {
    const predictions = await nsfwModel.classify(tensor);

    // Sum up NSFW-related categories (Porn + Hentai + Sexy)
    let nsfwScore = 0;
    for (const pred of predictions) {
      if (pred.className === 'Porn' || pred.className === 'Hentai' || pred.className === 'Sexy') {
        nsfwScore += pred.probability;
      }
    }

    const result: NSFWResult = nsfwScore >= NSFW_THRESHOLD ? 'nsfw' : 'sfw';
    console.log(`[NSFWClassifier] Score: ${nsfwScore.toFixed(3)} → ${result}`);
    return result;
  } finally {
    tensor.dispose();
  }
}

/**
 * Preloads the NSFW model. Call at server startup to avoid cold-start latency.
 */
export async function preloadModel(): Promise<void> {
  await getModel();
}
