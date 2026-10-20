import { describe, it, expect } from '@jest/globals';

import { expectPending, heldPromise } from '../../utils/held-promise';

describe('heldPromise / expectPending', () => {
  it('stays pending while held and settles after release', async () => {
    const held = heldPromise<number>();
    const run = held.hold().then((n) => n + 1);
    await expectPending(run);
    held.release(1);
    await expect(run).resolves.toBe(2);
  });

  it('rejects the held promise on reject', async () => {
    const held = heldPromise();
    const run = held.hold();
    await expectPending(run);
    held.reject(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
  });

  it('hands out the same promise on every hold()', () => {
    const held = heldPromise();
    expect(held.hold()).toBe(held.hold());
  });

  it.each([
    ['resolved', Promise.resolve(1)],
    ['rejected', Promise.reject(new Error('x'))],
  ])('expectPending throws for an already %s promise', async (_label, promise) => {
    await expect(expectPending(promise)).rejects.toThrow('still be pending');
  });
});
