import { jest } from '@jest/globals';

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: jest.fn(),
  resolveDjNameForShow: jest.fn().mockResolvedValue(null),
}));

import { addEntry } from '../../../apps/backend/controllers/flowsheet.controller';
import * as flowsheet_service from '../../../apps/backend/services/flowsheet.service';

describe('addEntry', () => {
  const mockStatus = jest.fn().mockReturnThis();
  const mockSend = jest.fn();
  const mockJson = jest.fn();

  const req = {
    body: { track_title: 'Test', artist_name: 'Artist', album_title: 'Album', record_label: 'Label' },
  } as any;
  const res = { status: mockStatus, send: mockSend, json: mockJson } as any;
  const next = jest.fn();

  it('should reject with the error when getLatestShow throws', async () => {
    const dbError = new Error('DB connection failed');
    (flowsheet_service.getLatestShow as jest.Mock).mockRejectedValue(dbError);

    await expect(addEntry(req, res, next)).rejects.toThrow(dbError);
    expect(mockStatus).not.toHaveBeenCalled();
  });
});
