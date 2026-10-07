/**
 * Body validation for PATCH /library/rotation/thresholds: partial at both
 * levels, integers in 1..365, explicit null and unknown keys rejected.
 */
import { parseRotationThresholdsPatch } from '../../../apps/backend/utils/rotation-thresholds';

describe('parseRotationThresholdsPatch', () => {
  test.each([
    ['an empty body', {}, {}],
    ['an undefined body', undefined, {}],
    ['an empty window_days', { window_days: {} }, {}],
    ['one bin', { window_days: { H: 30 } }, { window_days: { H: 30 } }],
    [
      'every bin at the bounds',
      { window_days: { H: 1, M: 365, L: 60, S: 2 } },
      { window_days: { H: 1, M: 365, L: 60, S: 2 } },
    ],
    ['card_stale_days alone', { card_stale_days: 14 }, { card_stale_days: 14 }],
    ['both levels', { window_days: { S: 90 }, card_stale_days: 45 }, { window_days: { S: 90 }, card_stale_days: 45 }],
  ])('accepts %s', (_label, body, expected) => {
    expect(parseRotationThresholdsPatch(body)).toEqual(expected);
  });

  test.each([
    ['zero', { window_days: { H: 0 } }, 'window_days.H'],
    ['above the ceiling', { window_days: { M: 366 } }, 'window_days.M'],
    ['negative', { window_days: { L: -1 } }, 'window_days.L'],
    ['fractional', { window_days: { S: 1.5 } }, 'window_days.S'],
    ['a numeric string', { window_days: { H: '60' } }, 'window_days.H'],
    ['a boolean', { window_days: { H: true } }, 'window_days.H'],
    ['null inside window_days', { window_days: { H: null } }, 'window_days.H'],
    ['card_stale_days zero', { card_stale_days: 0 }, 'card_stale_days'],
    ['card_stale_days above the ceiling', { card_stale_days: 366 }, 'card_stale_days'],
    ['card_stale_days fractional', { card_stale_days: 2.5 }, 'card_stale_days'],
    ['null card_stale_days', { card_stale_days: null }, 'card_stale_days'],
    ['null window_days', { window_days: null }, 'window_days'],
    ['an array window_days', { window_days: [] }, 'window_days'],
    ['a scalar window_days', { window_days: 60 }, 'window_days'],
    ['an unknown top-level key', { foo: 1 }, 'foo'],
    ['a lower-case bin key', { window_days: { h: 30 } }, 'h'],
    ['a padded bin key', { window_days: { ' H': 30 } }, ' H'],
    ['an unknown bin key', { window_days: { X: 30 } }, 'X'],
    ['an array body', [], 'body'],
    ['a scalar body', 'x', 'body'],
  ])('rejects %s with a 400 naming %s', (_label, body, named) => {
    let thrown: unknown;
    try {
      parseRotationThresholdsPatch(body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ statusCode: 400 });
    expect((thrown as Error).message).toContain(named);
  });
});
