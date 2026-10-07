/**
 * Unit tests for the workflow-step helper (tests/utils/workflow-step.ts), which
 * executes a GitHub Actions `run:` script from Jest. Pins the four failure
 * messages so a reworded step names what went missing instead of failing
 * generically, plus the run contract itself.
 */
import { findStep, runBashScript, sliceScript, stepEnvFrom } from '../../utils/workflow-step';

describe('workflow-step helper errors', () => {
  it.each<[string, () => unknown, string]>([
    ['a missing step', () => findStep({ steps: [{ name: 'a', run: 'true' }] }, 'b'), 'step "b" not found'],
    ['a step with no run', () => findStep({ steps: [{ name: 'a' }] }, 'a'), 'step "a" not found'],
    ['a missing slice marker', () => sliceScript('echo hi', 'echo', 'nope'), 'marker "nope" not found'],
    [
      'an unmapped env expression',
      () => stepEnvFrom({ env: { X: '${{ inputs.x }}' }, run: 'true' }, {}),
      'unexpected env expression X: ${{ inputs.x }}',
    ],
  ])('names %s', (_label, act, message) => {
    expect(act).toThrow(message);
  });
});

describe('workflow-step helper run contract', () => {
  it('maps env expressions and runs under -eo pipefail with only PATH plus the given env', () => {
    const env = stepEnvFrom({ env: { X: '${{ inputs.x }}' }, run: 'true' }, { '${{ inputs.x }}': 'v' });
    expect(env).toEqual({ X: 'v' });
    expect(runBashScript('echo "$X"; false; echo unreachable', { env, cwd: process.cwd() })).toMatchObject({
      status: 1,
      stdout: 'v\n',
    });
  });

  it('slices between two markers', () => {
    expect(sliceScript('a\nSTART\nb\nEND\nc', 'START', 'END')).toBe('START\nb\n');
  });
});
