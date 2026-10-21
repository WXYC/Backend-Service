/**
 * `label_id` against `record_label` on `POST /intake` and `PATCH /intake/{id}` (BS#3583): a request that carries both is refused
 * with a 400 `label_mismatch`, before any write, unless the label row's name matches `record_label`. A request with only one of
 * the two (or that clears one with `null`) is not checked. The comparison itself (case-insensitive, trimmed) is SQL, so
 * `intake.service.sql.test.ts` pins its shape and `tests/integration/intake-label-match.spec.js` its behavior against real rows.
 */
const mockLog = jest.fn<Promise<unknown>, unknown[]>();
const mockUpdate = jest.fn<Promise<unknown>, unknown[]>();
const mockLabelNameMatches = jest.fn<Promise<boolean | undefined>, unknown[]>();

jest.mock('../../../apps/backend/services/intake.service', () => ({
  logIntakeItem: mockLog,
  updateIntakeItem: mockUpdate,
  labelNameMatches: mockLabelNameMatches,
}));
jest.mock('../../../apps/backend/services/intake-links.service', () => ({ lookUpIntakeLinks: jest.fn() }));
jest.mock('../../../apps/backend/services/review-notices.service', () => ({}));
jest.mock('../../../apps/backend/services/review-print.service', () => ({ printIntakeItem: jest.fn() }));
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));
jest.mock('../../../apps/backend/utils/review-grants', () => ({}));

import type { Request, Response } from 'express';
import { logIntake, patchIntake } from '../../../apps/backend/controllers/intake.controller';

const respond = () => ({ json: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) }) as unknown as Response;
const create = (body: object) =>
  logIntake(
    {
      body: { artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again', format_id: 1, ...body },
      auth: { id: 'dj-1' },
    } as unknown as Request,
    respond(),
    jest.fn()
  );
const patch = (body: object) =>
  patchIntake({ params: { id: '4' }, body } as unknown as Request<{ id: string }>, respond(), jest.fn());

beforeEach(() => {
  jest.clearAllMocks();
  mockLog.mockResolvedValue({ outcome: 'logged', item: {} });
  mockUpdate.mockResolvedValue({ outcome: 'updated', item: {}, renamed: false });
});

describe.each([
  ['POST /intake', create, mockLog],
  ['PATCH /intake/{id}', patch, mockUpdate],
])('%s label_id and record_label', (_verb, send, write) => {
  test.each([
    ['a matching name', { label_id: 7, record_label: 'Drag City' }, true, ['Drag City']],
    [
      'a name that differs only in case and whitespace',
      { label_id: 7, record_label: '  drag city ' },
      true,
      ['drag city'],
    ],
  ])('accepts %s and writes', async (_name, body, matches, checkedName) => {
    mockLabelNameMatches.mockResolvedValue(matches);
    await send(body);
    expect(mockLabelNameMatches).toHaveBeenCalledWith(7, ...checkedName);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('refuses a mismatched name with a 400 label_mismatch and writes nothing', async () => {
    mockLabelNameMatches.mockResolvedValue(false);
    await expect(send({ label_id: 7, record_label: 'Sonamos' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'label_mismatch',
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('leaves a label_id that names no label to the write, which answers unknown_reference', async () => {
    mockLabelNameMatches.mockResolvedValue(undefined);
    write.mockResolvedValue({ outcome: 'unknown_reference' });
    await expect(send({ label_id: 2147483000, record_label: 'Drag City' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'format_id or label_id does not exist',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['label_id only', { label_id: 7 }],
    ['record_label only', { record_label: 'Drag City' }],
    ['record_label with a cleared label_id', { label_id: null, record_label: 'Drag City' }],
    ['label_id with a cleared record_label', { label_id: 7, record_label: null }],
    ['label_id with a blank record_label', { label_id: 7, record_label: '   ' }],
  ])('does not check %s', async (_name, body) => {
    await send(body);
    expect(mockLabelNameMatches).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
