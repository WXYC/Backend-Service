import { db, createMockQueryChain } from '../../mocks/database.mock';
import { getAdjacentShowIds } from '../../../apps/backend/services/flowsheet.service';

/**
 * The archive walk behind `GET /flowsheet/playlist?show_id=`. Two lookups, one
 * in each direction, each returning an id or nothing — the ends of the archive
 * are the interesting cases, because tubafrenzy got them wrong: both of its
 * queries ended in `.orElse(0)`, so the oldest show's "<< Previous Show" linked
 * to `radioShowID=0` and threw `RadioShowDoesNotExistException`. Null is the
 * deliberate divergence.
 */
describe('getAdjacentShowIds', () => {
  const START_TIME = new Date('2026-09-07T10:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Stubs the two neighbour lookups in call order: previous, then next. */
  const stubNeighbours = (previous: unknown[], next: unknown[]) => {
    const previousSelect = createMockQueryChain();
    previousSelect.limit.mockResolvedValue(previous);
    db.select.mockReturnValueOnce(previousSelect);

    const nextSelect = createMockQueryChain();
    nextSelect.limit.mockResolvedValue(next);
    db.select.mockReturnValueOnce(nextSelect);

    return { previousSelect, nextSelect };
  };

  it('returns both neighbour ids for a show in the middle of the archive', async () => {
    stubNeighbours([{ id: 41 }], [{ id: 43 }]);

    await expect(getAdjacentShowIds(42, START_TIME)).resolves.toEqual({
      previous_show_id: 41,
      next_show_id: 43,
    });
  });

  it('returns a null previous_show_id on the oldest show — never 0 (the tubafrenzy bug)', async () => {
    stubNeighbours([], [{ id: 2 }]);

    await expect(getAdjacentShowIds(1, START_TIME)).resolves.toEqual({
      previous_show_id: null,
      next_show_id: 2,
    });
  });

  it('returns a null next_show_id on the newest show', async () => {
    stubNeighbours([{ id: 72892 }], []);

    await expect(getAdjacentShowIds(72893, START_TIME)).resolves.toEqual({
      previous_show_id: 72892,
      next_show_id: null,
    });
  });

  it('returns nulls at both ends when the archive holds one show', async () => {
    stubNeighbours([], []);

    await expect(getAdjacentShowIds(1, START_TIME)).resolves.toEqual({
      previous_show_id: null,
      next_show_id: null,
    });
  });

  it('costs exactly two queries — one per direction, never a scan per candidate', async () => {
    stubNeighbours([{ id: 41 }], [{ id: 43 }]);

    await getAdjacentShowIds(42, START_TIME);

    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('truncates each direction at one row', async () => {
    const { previousSelect, nextSelect } = stubNeighbours([{ id: 41 }], [{ id: 43 }]);

    await getAdjacentShowIds(42, START_TIME);

    expect(previousSelect.limit).toHaveBeenCalledWith(1);
    expect(nextSelect.limit).toHaveBeenCalledWith(1);
  });
});
