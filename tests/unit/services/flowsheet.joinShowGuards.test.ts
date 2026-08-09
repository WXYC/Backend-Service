import { eq, desc, and, isNull } from 'drizzle-orm';
import { db, createMockQueryChain, flowsheet, show_djs, shows } from '../../mocks/database.mock';
import {
  closeShowFromTerminalShowEndMarker,
  isLatestEntryShowEnd,
  isDjAlreadyActiveOnShow,
} from '../../../apps/backend/services/flowsheet.service';

/**
 * Unit shape-pins for the two belt-and-braces reads `joinShow` uses (BS#1861
 * options (b) and (c)). The end-to-end start-vs-join decision is covered by
 * the controller unit tests (tests/unit/controllers/flowsheet.controller.test.ts)
 * and by the integration spec exercising the real webhook → join sequence
 * against Postgres; these tests pin each read in isolation.
 */
describe('flowsheet.service: joinShow belt-and-braces guards (BS#1861)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isLatestEntryShowEnd', () => {
    it('returns true when the newest flowsheet entry for the show is show_end', async () => {
      const chain = createMockQueryChain();
      chain.limit.mockResolvedValue([{ entry_type: 'show_end' }]);
      db.select.mockReturnValueOnce(chain);

      await expect(isLatestEntryShowEnd(42)).resolves.toBe(true);

      // Filters by show_id, orders by id DESC (insertion order — immune to
      // play_order renumbering from changeOrder), takes only the newest row.
      expect(chain.where).toHaveBeenCalledWith(eq(flowsheet.show_id, 42));
      expect(chain.orderBy).toHaveBeenCalledWith(desc(flowsheet.id));
      expect(chain.limit).toHaveBeenCalledWith(1);
    });

    it('returns false when the newest entry is not show_end', async () => {
      const chain = createMockQueryChain();
      chain.limit.mockResolvedValue([{ entry_type: 'dj_join' }]);
      db.select.mockReturnValueOnce(chain);

      await expect(isLatestEntryShowEnd(42)).resolves.toBe(false);
    });

    it('returns false when the show has no flowsheet entries at all', async () => {
      const chain = createMockQueryChain();
      chain.limit.mockResolvedValue([]);
      db.select.mockReturnValueOnce(chain);

      await expect(isLatestEntryShowEnd(42)).resolves.toBe(false);
    });
  });

  describe('isDjAlreadyActiveOnShow', () => {
    const show = { id: 1, primary_dj_id: 'dj-A' } as unknown as Parameters<typeof isDjAlreadyActiveOnShow>[0];

    it('returns true for the primary DJ without a show_djs round trip', async () => {
      await expect(isDjAlreadyActiveOnShow(show, 'dj-A')).resolves.toBe(true);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns true when a co-host show_djs row is active', async () => {
      const chain = createMockQueryChain();
      chain.limit.mockResolvedValue([{ active: true }]);
      db.select.mockReturnValueOnce(chain);

      await expect(isDjAlreadyActiveOnShow(show, 'dj-B')).resolves.toBe(true);
      expect(chain.where).toHaveBeenCalledWith(and(eq(show_djs.show_id, 1), eq(show_djs.dj_id, 'dj-B')));
    });

    it('returns false when the co-host show_djs row is inactive', async () => {
      const chain = createMockQueryChain();
      chain.limit.mockResolvedValue([{ active: false }]);
      db.select.mockReturnValueOnce(chain);

      await expect(isDjAlreadyActiveOnShow(show, 'dj-B')).resolves.toBe(false);
    });

    it('returns false when no show_djs row exists for the DJ', async () => {
      const chain = createMockQueryChain();
      chain.limit.mockResolvedValue([]);
      db.select.mockReturnValueOnce(chain);

      await expect(isDjAlreadyActiveOnShow(show, 'dj-B')).resolves.toBe(false);
    });
  });

  describe('closeShowFromTerminalShowEndMarker (BS#2065)', () => {
    it('keeps the WHERE end_time IS NULL guard and re-checks the show_end marker in the same statement', async () => {
      const chain = createMockQueryChain([{ id: 5 }]);
      db.update.mockReturnValueOnce(chain);

      await expect(closeShowFromTerminalShowEndMarker(5)).resolves.toBe(1);

      expect(db.update).toHaveBeenCalledWith(shows);
      expect(chain.where).toHaveBeenCalledWith(
        and(
          eq(shows.id, 5),
          // The data-safety guard carried over verbatim from the webhook
          // fast-path: never overwrite an end_time that a later delivery of
          // the same show_end — or #1543's authoritative dump pass — set.
          isNull(shows.end_time),
          // …and the marker type is re-evaluated inside the UPDATE rather
          // than trusted from the caller's separate isLatestEntryShowEnd read.
          expect.objectContaining({ sql: expect.arrayContaining([" = 'show_end'"]) })
        )
      );
    });

    it("writes the marker row's own add_time, not a fresh clock reading", async () => {
      const chain = createMockQueryChain([{ id: 5 }]);
      db.update.mockReturnValueOnce(chain);

      await closeShowFromTerminalShowEndMarker(5);

      // Consistency with the fast-path, which derives the marker row and
      // shows.end_time from a single clock reading per delivery.
      expect(chain.set).toHaveBeenCalledWith({
        end_time: expect.objectContaining({ values: expect.arrayContaining([flowsheet.add_time]) }),
      });
      expect(JSON.stringify(chain.set.mock.calls[0]?.[0])).not.toContain('now()');
    });

    it('swallows a DB error rather than 500-ing the go-live the (b) guard was about to route (BS#1861)', async () => {
      const chain = createMockQueryChain();
      chain.returning.mockRejectedValue(new Error('connection terminated'));
      db.update.mockReturnValueOnce(chain);

      await expect(closeShowFromTerminalShowEndMarker(5)).resolves.toBe(0);
    });

    it('reports 0 when the guarded UPDATE matched nothing (already closed, or no show_end marker)', async () => {
      const chain = createMockQueryChain([]);
      db.update.mockReturnValueOnce(chain);

      await expect(closeShowFromTerminalShowEndMarker(5)).resolves.toBe(0);
    });
  });
});
