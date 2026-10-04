import * as Sentry from '@sentry/node';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

type Helper = typeof import('../../../apps/backend/utils/review-gate-cutover');

/** Fresh module per case so the once-per-process report flag starts clear. */
const load = (value: string | undefined): Helper => {
  if (value === undefined) delete process.env.REVIEW_GATE_CUTOVER_DATE;
  else process.env.REVIEW_GATE_CUTOVER_DATE = value;
  let mod!: Helper;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../../apps/backend/utils/review-gate-cutover');
  });
  return mod;
};

afterEach(() => {
  delete process.env.REVIEW_GATE_CUTOVER_DATE;
  jest.clearAllMocks();
});

describe('isGateOn (station time)', () => {
  it('is off while unset', () => {
    expect(load(undefined).isGateOn(new Date('2030-01-01T12:00:00Z'))).toBe(false);
  });

  it.each([
    ['the day before', '2027-01-11T17:00:00Z', false],
    ['the cutover day itself', '2027-01-12T17:00:00Z', true],
    ['the day after', '2027-01-13T17:00:00Z', true],
    // 03:00 UTC on the 13th is still 22:00 EST on the 12th at the station
    ['an instant already the next day in UTC but not at the station', '2027-01-13T03:00:00Z', true],
    ['an instant already the cutover day in UTC but not at the station', '2027-01-12T03:00:00Z', false],
  ])('%s', (_name, instant, expected) => {
    expect(load('2027-01-12').isGateOn(new Date(instant))).toBe(expected);
  });
});

describe('isOnOrBeforeCutover', () => {
  it('counts every stored date while unset', () => {
    expect(load(undefined).isOnOrBeforeCutover('2099-01-01')).toBe(true);
  });

  it.each([
    ['a date column the day before', '2027-01-11', true],
    ['a date column equal to the cutover', '2027-01-12', true],
    ['a date column the day after', '2027-01-13', false],
    ['a timestamptz on cutover night that is already the 13th in UTC', new Date('2027-01-13T03:00:00Z'), true],
    ['a timestamptz after station midnight', new Date('2027-01-13T05:00:00Z'), false],
  ])('%s', (_name, stored, expected) => {
    expect(load('2027-01-12').isOnOrBeforeCutover(stored)).toBe(expected);
  });
});

describe('a malformed value', () => {
  it.each(['2027-1-12', '2027-01-12 ', '2027-02-30', 'soon'])('%j is reported once and treated as on', (value) => {
    const helper = load(value);
    expect(helper.isGateOn(new Date('2020-01-01T00:00:00Z'))).toBe(true);
    expect(helper.isOnOrBeforeCutover('2000-01-01')).toBe(false);
    helper.isGateOn();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a well-formed or unset value', () => {
    load('2027-01-12').isGateOn();
    load(undefined).isGateOn();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
