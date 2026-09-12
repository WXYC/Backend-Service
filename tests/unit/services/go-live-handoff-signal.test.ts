/**
 * The forensic signal for a resolved go-live collision.
 *
 * A takeover is invisible in the archive afterwards -- `endShow` back-dates
 * `end_time` and `shows` has no `updated_at` -- so this event is the only
 * record that the branch ran, and the only thing that names the show it closed.
 */
import { jest } from '@jest/globals';

const mockCaptureMessage = jest.fn();

jest.mock('@sentry/node', () => ({ captureMessage: mockCaptureMessage }));

import { recordGoLiveHandoff } from '../../../apps/backend/services/flowsheet/go-live-handoff-signal';

describe('recordGoLiveHandoff', () => {
  it.each(['takeover', 'join'] as const)('names the %s and the show it resolved', (intent) => {
    recordGoLiveHandoff(intent, { open_show_id: 1951325, dj_id: 'bill-b' });

    // Literals, not the module's own constants: an assertion that imports the
    // value it checks passes for every value, including a typo.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      `Go-live handoff: ${intent}`,
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({ tool: 'flowsheet', handoff_intent: intent }),
        extra: expect.objectContaining({ open_show_id: 1951325, dj_id: 'bill-b' }),
      })
    );
  });

  // One issue per intent, so the count is the issue's event count and an alert
  // can fire on the first occurrence rather than on a threshold.
  it.each(['takeover', 'join'] as const)('groups every %s into one issue', (intent) => {
    recordGoLiveHandoff(intent, { open_show_id: 1, dj_id: 'a' });
    recordGoLiveHandoff(intent, { open_show_id: 2, dj_id: 'b' });

    const fingerprints = mockCaptureMessage.mock.calls.map(
      (call) => (call[1] as { fingerprint: string[] }).fingerprint
    );
    expect(fingerprints).toEqual([
      ['go-live-handoff', intent],
      ['go-live-handoff', intent],
    ]);
  });

  // A handoff is a thing that happened, not a fault. Levelled as an error it
  // would page whoever owns the Sentry error budget every time a DJ collides.
  it('does not report a handoff as an error', () => {
    recordGoLiveHandoff('takeover', { open_show_id: 1, dj_id: 'a' });

    const [, options] = mockCaptureMessage.mock.calls[0] as [string, { level: string }];
    expect(options.level).toBe('info');
  });
});
