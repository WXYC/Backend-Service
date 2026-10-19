import { jest, describe, it, expect, beforeEach } from '@jest/globals';

type Handler = (event: Record<string, unknown>) => void;
let oversizedHandler: Handler | undefined;
let errorHandler: Handler | undefined;
const mockLogCounter = jest.fn<(name: string, value: number, fields?: Record<string, unknown>) => void>();

jest.mock('@wxyc/observability', () =>
  jest
    .requireActual<typeof import('../../../utils/observability')>('../../../utils/observability')
    .mockObservabilityBarrel({ logCounter: mockLogCounter })
);
jest.mock('@wxyc/database', () => ({
  onCdcOversizedEvent: (h: Handler) => {
    oversizedHandler = h;
  },
  onCdcErrorEvent: (h: Handler) => {
    errorHandler = h;
  },
  startCdcListener: jest.fn(),
  stopCdcListener: jest.fn(),
}));

import { registerCdcFallbackSinks, shutdownCdcDispatcher } from '../../../../apps/backend/services/cdc/dispatcher';

describe('CDC fallback sinks (BS#3402)', () => {
  beforeEach(async () => {
    mockLogCounter.mockClear();
    await shutdownCdcDispatcher();
    registerCdcFallbackSinks();
  });

  it('logs cdc.oversized_payload with the row coordinates and size', () => {
    oversizedHandler({
      table: 'flowsheet',
      schema: 'wxyc_schema',
      action: 'UPDATE',
      primary_key: '42',
      payload_bytes: 9000,
      timestamp: 1,
      reason: 'payload_too_large',
    });
    expect(mockLogCounter).toHaveBeenCalledWith('cdc.oversized_payload', 1, {
      subsystem: 'cdc',
      table: 'flowsheet',
      action: 'UPDATE',
      reason: 'payload_too_large',
      schema: 'wxyc_schema',
      primary_key: '42',
      payload_bytes: 9000,
    });
  });

  it('logs cdc.trigger_exception with the sqlstate', () => {
    errorHandler({
      table: 'flowsheet',
      schema: 'wxyc_schema',
      action: 'INSERT',
      sqlstate: '22P02',
      sqlerrm: 'boom',
      timestamp: 1,
      reason: 'trigger_exception',
    });
    expect(mockLogCounter).toHaveBeenCalledWith('cdc.trigger_exception', 1, {
      subsystem: 'cdc',
      table: 'flowsheet',
      action: 'INSERT',
      reason: 'trigger_exception',
      sqlstate: '22P02',
      schema: 'wxyc_schema',
    });
  });
});
