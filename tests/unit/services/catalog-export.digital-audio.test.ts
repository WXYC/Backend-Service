/**
 * Unit test for the `has_digital_audio` projection added to
 * `getCatalogExportRows` (BS#2320): the EXISTS subquery is only present in
 * the built SQL when the digital-archive flag is on; with the flag off, the
 * column collapses to the literal `false` at query-build time rather than
 * running a per-row EXISTS that the flag would then have to re-suppress.
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';

const mockGetDigitalArchiveConfig = jest.fn<() => { enabled: boolean; signTTLSeconds: number }>();
jest.mock('../../../apps/backend/config/digitalArchive', () => ({
  getConfig: mockGetDigitalArchiveConfig,
}));

import { getCatalogExportRows } from '../../../apps/backend/services/catalog-export.service';

describe('getCatalogExportRows: has_digital_audio flag gate', () => {
  beforeEach(() => {
    db.execute.mockReset().mockResolvedValue([]);
  });

  it('emits a literal false with no digital_asset EXISTS when the flag is off', async () => {
    mockGetDigitalArchiveConfig.mockReturnValue({ enabled: false, signTTLSeconds: 14400 });
    await getCatalogExportRows();
    const rendered = renderSql(db.execute.mock.calls[0][0]);
    expect(rendered).toMatch(/AS has_digital_audio/i);
    expect(rendered).not.toMatch(/EXISTS/i);
    expect(rendered).not.toMatch(/digital_asset/i);
  });

  it('emits an EXISTS(... status = bound ...) subquery when the flag is on', async () => {
    mockGetDigitalArchiveConfig.mockReturnValue({ enabled: true, signTTLSeconds: 14400 });
    await getCatalogExportRows();
    const rendered = renderSql(db.execute.mock.calls[0][0]);
    expect(rendered).toMatch(/EXISTS/i);
    expect(rendered).toMatch(/status/i);
  });
});
