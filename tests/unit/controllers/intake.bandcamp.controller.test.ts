/**
 * The Bandcamp link on `POST /intake` and `PATCH /intake/{id}` (BS#3390): one parse for both verbs, a 400 before any write for a link
 * that is not an `https` Bandcamp URL of at most 512 characters, and `bandcamp_url_entered` derived from the link a request carries.
 */
const mockLog = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUpdate = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/intake.service', () => ({
  logIntakeItem: mockLog,
  updateIntakeItem: mockUpdate,
}));
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
      body: { artist_name: 'Juana Molina', album_title: 'DOGA', format_id: 1, ...body },
      auth: { id: 'dj-1' },
    } as unknown as Request,
    respond(),
    jest.fn()
  );
const patch = (body: object) =>
  patchIntake({ params: { id: '4' }, body } as unknown as Request<{ id: string }>, respond(), jest.fn());

const ACCEPTED = [
  ['a label subdomain', 'https://label.bandcamp.com/album/x'],
  ['the bare host', 'https://bandcamp.com/juana-molina'],
  ['a deeper subdomain', 'https://a.b.bandcamp.com/album/x'],
  ['an upper-case host', 'https://Label.Bandcamp.com/album/x'],
  ['exactly 512 characters', `https://label.bandcamp.com/${'a'.repeat(512 - 'https://label.bandcamp.com/'.length)}`],
];
const REFUSED = [
  ['plain http', 'http://label.bandcamp.com/album/x'],
  ['another host with bandcamp.com in the path', 'https://evil.com/bandcamp.com'],
  ['bandcamp.com as a prefix of another host', 'https://bandcamp.com.evil.com'],
  ['a host that only ends in the letters', 'https://notbandcamp.com/album/x'],
  ['credentials naming another host', 'https://label.bandcamp.com@evil.com/x'],
  ['a non-URL', 'not a link'],
  ['more than 512 characters', `https://label.bandcamp.com/${'a'.repeat(512)}`],
  ['a number', 12],
];

beforeEach(() => {
  jest.clearAllMocks();
  mockLog.mockResolvedValue({ outcome: 'logged', item: {} });
  mockUpdate.mockResolvedValue({ outcome: 'updated', item: {} });
});

describe.each([
  ['POST /intake', create, mockLog],
  ['PATCH /intake/{id}', patch, mockUpdate],
])('%s bandcamp_url', (_verb, send, service) => {
  test.each(ACCEPTED)('accepts %s and marks the link entered', async (_name, url) => {
    await send({ bandcamp_url: url });
    expect(service.mock.calls[0][service === mockLog ? 0 : 1]).toMatchObject({
      bandcamp_url: url,
      bandcamp_url_entered: true,
    });
  });

  test.each(REFUSED)('refuses %s with a 400 and writes nothing', async (_name, url) => {
    await expect(send({ bandcamp_url: url })).rejects.toMatchObject({ statusCode: 400 });
    expect(service).not.toHaveBeenCalled();
  });

  test('names the link in the refusal', async () => {
    await expect(send({ bandcamp_url: 'http://label.bandcamp.com/x' })).rejects.toThrow(
      'Invalid Parameter: bandcamp_url must be a Bandcamp link'
    );
  });

  test.each([
    ['null', null],
    ['a blank string', ''],
    ['whitespace', '   '],
  ])('treats %s as no link and clears the entered flag', async (_name, value) => {
    await send({ bandcamp_url: value });
    expect(service.mock.calls[0][service === mockLog ? 0 : 1]).toMatchObject({
      bandcamp_url: null,
      bandcamp_url_entered: false,
    });
  });
});

test('a create without a link leaves the flag to its column default', async () => {
  await create({});
  const sent = mockLog.mock.calls[0][0] as Record<string, unknown>;
  expect(sent.bandcamp_url).toBeUndefined();
  expect(sent.bandcamp_url_entered).toBeUndefined();
});

test('a patch without the key leaves the stored link and flag alone', async () => {
  await patch({ album_title: 'DOGA (2)' });
  const sent = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
  expect(sent).not.toHaveProperty('bandcamp_url');
  expect(sent).not.toHaveProperty('bandcamp_url_entered');
});
