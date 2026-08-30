/**
 * Unit tests for the startup catalog-export-flag reconciler (BS#2320).
 *
 * Pins the decision-comment algorithm exactly:
 *   - first boot (no row), flag false  -> INSERT only, no watermark touch
 *   - first boot (no row), flag true   -> INSERT, THEN touch
 *   - steady state, unchanged          -> no write, no touch
 *   - steady state, changed            -> UPDATE (with explicit changed_at), THEN touch
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';

import { reconcileCatalogExportFlag } from '../../../apps/backend/services/catalog-export-flag-reconcile.service';

const FLAG = 'DIGITAL_ARCHIVE_STREAMING_ENABLED';

describe('reconcileCatalogExportFlag', () => {
  const original = process.env[FLAG];

  beforeEach(() => {
    db.execute.mockReset();
  });

  afterAll(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  const statements = () => db.execute.mock.calls.map((call) => renderSql(call[0] as never));

  it('first boot, flag false: inserts the row and does NOT touch the watermark', async () => {
    process.env[FLAG] = 'false';
    db.execute.mockResolvedValueOnce([]); // SELECT: no existing row

    await reconcileCatalogExportFlag(FLAG);

    expect(db.execute).toHaveBeenCalledTimes(2); // SELECT + INSERT, no touch call
    const rendered = statements();
    expect(rendered[1]).toMatch(/INSERT INTO/i);
    expect(rendered.some((s) => /touch_library_watermark_now/i.test(s))).toBe(false);
  });

  it('first boot, flag true: inserts the row AND touches the watermark', async () => {
    process.env[FLAG] = 'true';
    db.execute.mockResolvedValueOnce([]); // SELECT: no existing row

    await reconcileCatalogExportFlag(FLAG);

    expect(db.execute).toHaveBeenCalledTimes(3); // SELECT + INSERT + touch
    const rendered = statements();
    expect(rendered[1]).toMatch(/INSERT INTO/i);
    expect(rendered[2]).toMatch(/touch_library_watermark_now/i);
  });

  it('steady state, unchanged (false -> false): no write, no touch', async () => {
    process.env[FLAG] = 'false';
    db.execute.mockResolvedValueOnce([{ value: 'false' }]);

    await reconcileCatalogExportFlag(FLAG);

    expect(db.execute).toHaveBeenCalledTimes(1); // SELECT only
  });

  it('steady state, unchanged (true -> true): no write, no touch', async () => {
    process.env[FLAG] = 'true';
    db.execute.mockResolvedValueOnce([{ value: 'true' }]);

    await reconcileCatalogExportFlag(FLAG);

    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('steady state, changed (false -> true): updates with an explicit changed_at, then touches', async () => {
    process.env[FLAG] = 'true';
    db.execute.mockResolvedValueOnce([{ value: 'false' }]);

    await reconcileCatalogExportFlag(FLAG);

    expect(db.execute).toHaveBeenCalledTimes(3); // SELECT + UPDATE + touch
    const rendered = statements();
    expect(rendered[1]).toMatch(/UPDATE/i);
    expect(rendered[1]).toMatch(/changed_at/i);
    expect(rendered[1]).not.toMatch(/DEFAULT/i);
    expect(rendered[2]).toMatch(/touch_library_watermark_now/i);
  });

  it('steady state, changed (true -> false): updates and touches (kill-switch-off still advances the watermark)', async () => {
    process.env[FLAG] = 'false';
    db.execute.mockResolvedValueOnce([{ value: 'true' }]);

    await reconcileCatalogExportFlag(FLAG);

    expect(db.execute).toHaveBeenCalledTimes(3);
    const rendered = statements();
    expect(rendered[1]).toMatch(/UPDATE/i);
    expect(rendered[2]).toMatch(/touch_library_watermark_now/i);
  });
});
