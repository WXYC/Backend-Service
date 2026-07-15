/**
 * Unit tests for the NSFW artwork classifier's model loader.
 *
 * Regression coverage for #1121: a transient first-load failure must NOT be
 * cached forever. The in-flight slot has to reset on rejection so the next
 * call retries the load, and preloadModel() must swallow the failure so a
 * cold-start blip can't crash the server.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

const mockLoad = jest.fn<() => Promise<unknown>>();
const mockClassify = jest.fn<() => Promise<Array<{ className: string; probability: number }>>>();
const mockDispose = jest.fn();
const mockTensor3d = jest.fn<() => { dispose: () => void }>();
const mockSharp = jest.fn<() => unknown>();
const mockToBuffer = jest.fn<() => Promise<{ data: Buffer; info: { height: number; width: number } }>>();

jest.mock('nsfwjs', () => ({
  load: mockLoad,
}));

jest.mock('@tensorflow/tfjs', () => ({
  tensor3d: mockTensor3d,
}));

jest.mock('sharp', () => ({
  __esModule: true,
  default: mockSharp,
}));

const NSFW_MODULE = '../../../apps/backend/services/artwork/nsfw';

async function loadNsfwModule() {
  jest.resetModules();
  return import(NSFW_MODULE);
}

describe('NSFW model loader (#1121)', () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockClassify.mockReset();
    mockDispose.mockReset();
    mockTensor3d.mockReset();
    mockSharp.mockReset();
    mockToBuffer.mockReset();

    // Happy-path decode + inference defaults; individual tests override load().
    mockClassify.mockResolvedValue([{ className: 'Neutral', probability: 0.99 }]);
    mockToBuffer.mockResolvedValue({ data: Buffer.alloc(3), info: { height: 1, width: 1 } });
    mockTensor3d.mockReturnValue({ dispose: mockDispose });
    mockSharp.mockReturnValue({
      removeAlpha: () => ({ raw: () => ({ toBuffer: mockToBuffer }) }),
    });
  });

  it('retries the model load on the next call after a transient first-load failure', async () => {
    mockLoad
      .mockRejectedValueOnce(new Error('transient GPU init failure'))
      .mockResolvedValue({ classify: mockClassify });

    const { classify } = await loadNsfwModule();

    // First call surfaces the load failure to the caller.
    await expect(classify(Buffer.from('art'))).rejects.toThrow('transient GPU init failure');

    // Second call must re-attempt the load (not replay the cached rejection).
    await expect(classify(Buffer.from('art'))).resolves.toBe('sfw');

    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('caches the model after a successful load (no redundant reload)', async () => {
    mockLoad.mockResolvedValue({ classify: mockClassify });

    const { classify } = await loadNsfwModule();

    await expect(classify(Buffer.from('art'))).resolves.toBe('sfw');
    await expect(classify(Buffer.from('art'))).resolves.toBe('sfw');

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('preloadModel() does not throw on a transient load failure', async () => {
    mockLoad.mockRejectedValueOnce(new Error('cold-start blip'));

    const { preloadModel } = await loadNsfwModule();

    await expect(preloadModel()).resolves.toBeUndefined();
  });

  it('lazy classify() recovers after a failed preloadModel()', async () => {
    mockLoad.mockRejectedValueOnce(new Error('cold-start blip')).mockResolvedValue({ classify: mockClassify });

    const { preloadModel, classify } = await loadNsfwModule();

    await preloadModel(); // swallows the failure, resets the in-flight slot

    await expect(classify(Buffer.from('art'))).resolves.toBe('sfw');
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});
