/**
 * Unit tests for the workflow-step helper (tests/utils/workflow-step.ts), which
 * executes a GitHub Actions `run:` script from Jest. Pins the failure
 * messages so a reworded step names what went missing instead of failing
 * generically, plus the run contract itself.
 */
import { findStep, runBashScript, sliceScript, stepEnvFrom } from '../../utils/workflow-step';

describe('workflow-step helper errors', () => {
  it.each<[string, () => unknown, string]>([
    ['a missing step', () => findStep({ steps: [{ name: 'a', run: 'true' }] }, 'b'), 'step "b" not found'],
    ['a step with no run', () => findStep({ steps: [{ name: 'a' }] }, 'a'), 'step "a" has no run:'],
    ['a missing slice marker', () => sliceScript('echo hi', 'echo', 'nope'), 'marker "nope" not found'],
    [
      'an unmapped env expression',
      () => stepEnvFrom({ env: { X: '${{ inputs.x }}' }, run: 'true' }, {}),
      'unexpected env expression X: ${{ inputs.x }}',
    ],
    [
      'a prototype key as an env expression',
      () => stepEnvFrom({ env: { X: 'constructor' }, run: 'true' }, {}),
      'unexpected env expression X: constructor',
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

  it('fails a pipeline whose first command fails (pipefail) and does not leak process.env', () => {
    process.env.WORKFLOW_STEP_LEAK_CHECK = 'leaked';
    try {
      expect(runBashScript('false | cat', { cwd: process.cwd() }).status).not.toBe(0);
      expect(runBashScript('printf "[%s]" "$WORKFLOW_STEP_LEAK_CHECK"', { cwd: process.cwd() }).stdout).toBe('[]');
    } finally {
      delete process.env.WORKFLOW_STEP_LEAK_CHECK;
    }
  });

  it('slices between two markers', () => {
    expect(sliceScript('a\nSTART\nb\nEND\nc', 'START', 'END')).toBe('START\nb\n');
  });
});
