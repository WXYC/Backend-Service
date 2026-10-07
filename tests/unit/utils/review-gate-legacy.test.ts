import { isLegacyRotationRow, type RotationChainRow } from '../../../apps/backend/utils/review-gate-legacy';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const CUTOVER = '2027-01-12';

const row = (
  id: number,
  add_date: string,
  moved_from_rotation_id: number | null = null,
  album_id: number | null = null
): RotationChainRow => ({ id, album_id, add_date, moved_from_rotation_id });

afterEach(() => {
  delete process.env.REVIEW_GATE_CUTOVER_DATE;
});

describe('isLegacyRotationRow', () => {
  beforeEach(() => {
    process.env.REVIEW_GATE_CUTOVER_DATE = CUTOVER;
  });

  it.each([
    ['a pre-cutover row', [row(1, '2026-12-01')], true],
    ['a row dated the cutover day itself', [row(1, CUTOVER)], true],
    ['a post-cutover row', [row(1, '2027-01-13')], false],
    ['a linked row', [row(1, '2026-12-01', null, 7)], false],
    ['a post-cutover row moved from a legacy row', [row(2, '2027-02-01', 1), row(1, '2026-12-01')], true],
    ['a row moved twice from a legacy row', [row(3, '2027-03-01', 2), row(2, '2027-02-01', 1), row(1, CUTOVER)], true],
    ['a row moved from a post-cutover row', [row(2, '2027-02-01', 1), row(1, '2027-01-20')], false],
    ['a row moved from a linked legacy row', [row(2, '2027-02-01', 1), row(1, '2026-12-01', null, 7)], true],
    ['a row moved from a linked post-cutover row', [row(2, '2027-02-01', 1), row(1, '2027-01-20', null, 7)], false],
    [
      'a row whose chain has a linked ancestor between it and the legacy row',
      [row(3, '2027-03-01', 2), row(2, '2027-02-01', 1, 7), row(1, '2026-12-01')],
      true,
    ],
    ['a row moved from a row that is gone', [row(2, '2027-02-01', 1)], false],
    ['a loop in the moves, none of it legacy', [row(2, '2027-02-01', 1), row(1, '2027-02-02', 2)], false],
    ['a loop in the moves, with a legacy row in it', [row(2, '2027-02-01', 1), row(1, '2026-12-01', 2)], true],
  ])('%s', (_name, chain, expected) => {
    expect(isLegacyRotationRow(chain, chain[0].id)).toBe(expected);
  });

  it('is false when the row itself is not in the chain', () => {
    expect(isLegacyRotationRow([], 1)).toBe(false);
  });

  it('treats any unlinked row as legacy while the date is unset', () => {
    delete process.env.REVIEW_GATE_CUTOVER_DATE;
    expect(isLegacyRotationRow([row(1, '2099-01-01')], 1)).toBe(true);
    expect(isLegacyRotationRow([row(1, '2099-01-01', null, 7)], 1)).toBe(false);
  });
});
