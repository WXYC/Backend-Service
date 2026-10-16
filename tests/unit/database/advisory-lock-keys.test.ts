import { ADVISORY_LOCK_KEYS, RETIRED_ADVISORY_LOCK_KEYS } from '../../../shared/database/src/advisory-lock-keys';

describe('advisory-lock-keys registry', () => {
  const live = Object.entries(ADVISORY_LOCK_KEYS);
  const retired = Object.entries(RETIRED_ADVISORY_LOCK_KEYS);

  it('has no two entries, live or retired, sharing a value', () => {
    const values = [...live, ...retired].map(([, value]) => value);
    const duplicates = values.filter((value, i) => values.indexOf(value) !== i);
    expect(duplicates).toEqual([]);
  });

  it.each([...live, ...retired])('%s is a positive safe integer', (_name, value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  it('records the deployed key values unchanged', () => {
    expect(ADVISORY_LOCK_KEYS).toEqual({
      slackBanModerators: 20260808,
      stationPasscodeRotate: 20260905,
      restoreBatch: 20260919,
    });
    expect(RETIRED_ADVISORY_LOCK_KEYS).toEqual({ legacyMirrorReconcile: 17071707 });
  });
});
