/**
 * Unit tests for jobs/flowsheet-etl/show-id-map.ts.
 *
 * Extracted from jobs/flowsheet-etl/job.ts (BS#2119 PR 0) so the
 * legacy_show_id -> Backend shows.id mapper can be imported without starting
 * the ETL (job.ts invokes `run()` at module scope). Mirrors the
 * chain.then-mocking convention used by tests/unit/jobs/flowsheet-etl/job.djName.test.ts
 * for the same mocked-db shape.
 */
import { db } from '@wxyc/database';
import { buildShowIdMap } from '../../../../jobs/flowsheet-etl/show-id-map';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;

describe('buildShowIdMap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chain.then = jest.fn().mockReturnValue(chain);
  });

  it('maps legacy_show_id -> Backend shows.id', async () => {
    chain.then.mockImplementationOnce((resolve: (v: unknown) => void) =>
      resolve([
        { id: 10, legacyId: 1001 },
        { id: 11, legacyId: 1002 },
      ])
    );

    const map = await buildShowIdMap(db);

    expect(map.get(1001)).toBe(10);
    expect(map.get(1002)).toBe(11);
    expect(map.size).toBe(2);
  });

  it('skips rows with a null legacyId (dj-site-originated shows never mirrored from tubafrenzy)', async () => {
    chain.then.mockImplementationOnce((resolve: (v: unknown) => void) =>
      resolve([
        { id: 10, legacyId: null },
        { id: 11, legacyId: 1002 },
      ])
    );

    const map = await buildShowIdMap(db);

    expect(map.has(10)).toBe(false);
    expect(map.get(1002)).toBe(11);
    expect(map.size).toBe(1);
  });

  it('returns an empty map when no shows exist', async () => {
    chain.then.mockImplementationOnce((resolve: (v: unknown) => void) => resolve([]));

    const map = await buildShowIdMap(db);

    expect(map.size).toBe(0);
  });
});
