// WX-1.2.2 detector: catches future regressions in the JSON codec used to
// decode HTTP request bodies (express.json under the hood is JSON.parse on a
// UTF-8 buffer) and serialize @wxyc/shared DTOs out across mirror webhooks
// and HTTP responses.
import { CHARSET_TORTURE_ENTRIES, charsetEntryId } from '../../charset-torture';

describe('charset-torture: HTTP body wire codec', () => {
  it.each(CHARSET_TORTURE_ENTRIES.map((entry) => [charsetEntryId(entry), entry] as const))(
    'preserves %s through Buffer -> JSON.parse (the express.json byte path)',
    (_id, entry) => {
      const wire = Buffer.from(JSON.stringify({ value: entry.input }), 'utf-8');
      const decoded = JSON.parse(wire.toString('utf-8'));
      expect(decoded.value).toBe(entry.input);
    }
  );
});

describe('charset-torture: outbound JSON serialization', () => {
  it.each(CHARSET_TORTURE_ENTRIES.map((entry) => [charsetEntryId(entry), entry] as const))(
    'preserves %s through JSON.stringify -> JSON.parse (DTO -> wire -> DTO)',
    (_id, entry) => {
      const restored = JSON.parse(JSON.stringify({ value: entry.input }));
      expect(restored.value).toBe(entry.input);
    }
  );
});
