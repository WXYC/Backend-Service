/**
 * The Bandcamp link on `POST /intake` and `PATCH /intake/{id}` (BS#3390): one parse for both verbs, a 400 before any write for a link
 * that is not an `https` Bandcamp URL of at most 512 characters, and the parser's normalized `href` stored, never the raw input. The
 * `bandcamp_url_entered` flag is the service's to derive (`intake.service.sql.test.ts`), so the controller never sends it.
 */
const mockLog = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUpdate = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/intake.service', () => ({
  logIntakeItem: mockLog,
  updateIntakeItem: mockUpdate,
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
      body: { artist_name: 'Juana Molina', album_title: 'DOGA', format_id: 1, ...body },
      auth: { id: 'dj-1' },
    } as unknown as Request,
    respond(),
    jest.fn()
  );
const patch = (body: object) =>
  patchIntake({ params: { id: '4' }, body } as unknown as Request<{ id: string }>, respond(), jest.fn());

const AT_LIMIT = `https://label.bandcamp.com/${'a'.repeat(512 - 'https://label.bandcamp.com/'.length)}`;
/** [name, input, the normalized `href` the service is sent]. */
const ACCEPTED = [
  ['a label subdomain', 'https://label.bandcamp.com/album/x', 'https://label.bandcamp.com/album/x'],
  ['the bare host', 'https://bandcamp.com/juana-molina', 'https://bandcamp.com/juana-molina'],
  ['a deeper subdomain', 'https://a.b.bandcamp.com/album/x', 'https://a.b.bandcamp.com/album/x'],
  ['an upper-case host, lower-cased', 'https://Label.Bandcamp.com/album/x', 'https://label.bandcamp.com/album/x'],
  ['a host with no path, given its slash', 'https://label.bandcamp.com', 'https://label.bandcamp.com/'],
  ['no slashes after the scheme, given them', 'https:label.bandcamp.com/x', 'https://label.bandcamp.com/x'],
  ['exactly 512 characters', AT_LIMIT, AT_LIMIT],
];
const REFUSED = [
  ['plain http', 'http://label.bandcamp.com/album/x'],
  ['another host with bandcamp.com in the path', 'https://evil.com/bandcamp.com'],
  ['bandcamp.com as a prefix of another host', 'https://bandcamp.com.evil.example'],
  ['a host that only ends in the letters', 'https://evilbandcamp.com/album/x'],
  ['credentials naming another host', 'https://label.bandcamp.com@evil.com/x'],
  ['credentials on a Bandcamp host', 'https://user@label.bandcamp.com/x'],
  ['a backslash before userinfo', 'https://bandcamp.com\\@evil.example/x'],
  ['a backslash after the host', 'https://evil.example\\@bandcamp.com/x'],
  ['a backslash as the authority slashes', 'https:\\\\label.bandcamp.com/x'],
  ['a tab inside the host', 'https://ban\tdcamp.com/x'],
  ['a newline inside the host', 'https://ban\ndcamp.com/x'],
  ['a NUL character', 'https://label.bandcamp.com/\u0000x'],
  ['a DEL character', 'https://label.bandcamp.com/\u007fx'],
  ['an inner space', 'https://label.bandcamp.com/x y'],
  ['a non-URL', 'not a link'],
  ['more than 512 characters', `https://label.bandcamp.com/${'a'.repeat(512)}`],
  [
    '512 characters that normalize past the limit',
    `https://label.bandcamp.com/${'é'.repeat(512 - 'https://label.bandcamp.com/'.length)}`,
  ],
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
  const sent = () => service.mock.calls[0][service === mockLog ? 0 : 1] as Record<string, unknown>;

  test.each(ACCEPTED)('accepts %s and sends the normalized href', async (_name, url, stored) => {
    await send({ bandcamp_url: url });
    expect(sent().bandcamp_url).toBe(stored);
    expect(sent()).not.toHaveProperty('bandcamp_url_entered');
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
  ])('treats %s as no link and sends a clear', async (_name, value) => {
    await send({ bandcamp_url: value });
    expect(sent().bandcamp_url).toBeNull();
  });
});

test('a create without a link sends no link', async () => {
  await create({});
  expect((mockLog.mock.calls[0][0] as Record<string, unknown>).bandcamp_url).toBeUndefined();
});

test('a patch without the key leaves the stored link alone', async () => {
  await patch({ album_title: 'DOGA (2)' });
  expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty('bandcamp_url');
});
