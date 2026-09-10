import { eq, desc, and, isNull } from 'drizzle-orm';
import { db, createMockQueryChain, flowsheet, shows } from '../../mocks/database.mock';
import {
  closeShowFromTerminalShowEndMarker,
  isLatestEntryShowEnd,
} from '../../../apps/backend/services/flowsheet.service';

/**
 * Unit shape-pins for the reads `joinShow` uses (BS#1861 option (b), BS#2065).
 * The end-to-end start-vs-join decision is covered by the controller unit tests
 * (tests/unit/controllers/flowsheet.controller.test.ts) and by the integration
 * spec exercising the real webhook → join sequence against Postgres; these
 * tests pin each read in isolation.
 *
 * Option (c)'s `isDjAlreadyActiveOnShow` used to be pinned here too. BS#2405
 * removed the function: its answer — "the owner OR any active co-host" — was
 * one word wider than the guard needed, and that extra word is what made a
 * co-host unable to leave a show. Branch (c) now compares `dj_id ===
 * current_show.primary_dj_id` inline, which has no read to shape-pin; the
 * routing it decides is pinned in tests/unit/controllers/flowsheet.joinIntent.test.ts.
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
