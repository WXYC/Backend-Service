/**
 * Pin the cooperative-pause defaults so the values in `tests/mocks/database.mock.ts`
 * (which consumer unit tests import via `@wxyc/database`) can't drift from the
 * real values silently.
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
} from '../../../shared/database/src/live-activity';
import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT as MOCK_LOOKBACK,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT as MOCK_PAUSE,
} from '../../mocks/database.mock';

describe('live-activity defaults', () => {
  it('shared/database default matches database mock', () => {
    expect(MOCK_LOOKBACK).toBe(LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT);
    expect(MOCK_PAUSE).toBe(LIVE_ACTIVITY_PAUSE_MS_DEFAULT);
  });
});
