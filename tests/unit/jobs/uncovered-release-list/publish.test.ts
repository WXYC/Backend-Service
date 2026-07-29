/**
 * Unit tests for uncovered-release-list's publish.ts (BS#1877): the
 * research-data handoff. `publishSnapshot` takes an injectable
 * `fetch`-shaped function (mirroring
 * `album-critic-reviews-etl/fetch.test.ts`) so no real network call is
 * made — this module has never made a live call against
 * `WXYC/research-data` (see the module docstring and the job README's
 * "Handoff" section); these tests are what pins its Contents-API call
 * shape ahead of that.
 */
import {
  resolvePublishEnabled,
  resolveResearchDataWriteToken,
  publishSnapshot,
} from '../../../../jobs/uncovered-release-list/publish';

describe('resolvePublishEnabled', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, false],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['yes', false],
  ])('resolves %p -> %p (locked truthy set: true|1, case-insensitive)', (raw, expected) => {
    expect(resolvePublishEnabled(raw)).toBe(expected);
  });
});

describe('resolveResearchDataWriteToken', () => {
  it('returns null when unset or blank', () => {
    expect(resolveResearchDataWriteToken(undefined)).toBeNull();
    expect(resolveResearchDataWriteToken('   ')).toBeNull();
  });

  it('returns the token when set', () => {
    expect(resolveResearchDataWriteToken('ghp_write123')).toBe('ghp_write123');
  });
});

describe('publishSnapshot', () => {
  const content = '{"artist":"A","album":"B","library_id":1}\n';

  it('does not call fetch and reports not-attempted when PUBLISH is disabled', async () => {
    const fetchFn = jest.fn();
    const outcome = await publishSnapshot(content, { token: 'tok', publishEnabled: false, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ attempted: false, committed: false, reason: expect.stringMatching(/PUBLISH/) });
  });

  it('does not call fetch and reports not-attempted when the token is missing, even if PUBLISH is enabled', async () => {
    const fetchFn = jest.fn();
    const outcome = await publishSnapshot(content, { token: null, publishEnabled: true, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      attempted: false,
      committed: false,
      reason: expect.stringMatching(/RESEARCH_DATA_WRITE_TOKEN/),
    });
  });

  it('GETs the branch file sha, then PUTs base64 content with that sha (update-in-place)', async () => {
    const getResp = { status: 200, ok: true, json: () => Promise.resolve({ sha: 'abc123' }) };
    const putResp = { ok: true, status: 200, json: () => Promise.resolve({ commit: { sha: 'def456' } }) };
    const fetchFn = jest.fn().mockResolvedValueOnce(getResp).mockResolvedValueOnce(putResp);

    const outcome = await publishSnapshot(content, { token: 'tok', publishEnabled: true, fetchFn });

    expect(outcome).toEqual({ attempted: true, committed: true, commitSha: 'def456' });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [getUrl, getInit] = fetchFn.mock.calls[0];
    expect(getUrl).toContain('/repos/WXYC/research-data/contents/uncovered-releases.jsonl');
    expect(getUrl).toContain('ref=uncovered-releases-snapshot');
    expect((getInit.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    const [putUrl, putInit] = fetchFn.mock.calls[1];
    expect(putUrl).toBe('https://api.github.com/repos/WXYC/research-data/contents/uncovered-releases.jsonl');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body as string);
    expect(body.branch).toBe('uncovered-releases-snapshot');
    expect(body.sha).toBe('abc123');
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(content);
  });

  it('omits sha on the PUT when the GET 404s (first-ever commit to the branch)', async () => {
    const getResp = { status: 404, ok: false };
    const putResp = { ok: true, status: 200, json: () => Promise.resolve({ commit: { sha: 'first-commit' } }) };
    const fetchFn = jest.fn().mockResolvedValueOnce(getResp).mockResolvedValueOnce(putResp);

    const outcome = await publishSnapshot(content, { token: 'tok', publishEnabled: true, fetchFn });

    expect(outcome.committed).toBe(true);
    const putInit = fetchFn.mock.calls[1][1];
    const body = JSON.parse(putInit.body as string);
    expect(body).not.toHaveProperty('sha');
  });

  it('throws when the GET responds a non-404 non-ok status', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce({ status: 500, ok: false, statusText: 'Internal Server Error' });
    await expect(publishSnapshot(content, { token: 'tok', publishEnabled: true, fetchFn })).rejects.toThrow(
      /contents GET/i
    );
  });

  it('throws when the PUT responds non-ok', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({ ok: false, status: 422, statusText: 'Unprocessable Entity' });
    await expect(publishSnapshot(content, { token: 'tok', publishEnabled: true, fetchFn })).rejects.toThrow(
      /contents PUT/i
    );
  });
});
