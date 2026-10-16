/**
 * Guard for `tests/mocks/library-service.mock.ts` (BS#2209): the shared
 * `library.service` double must cover every runtime export of the real module.
 * A value export missing from the mock surfaces as `undefined` at a
 * comparison site (`limit > undefined` is false, so over-limit requests 200),
 * so the check is here, loud and named, rather than in whichever suite
 * happens to trip over it.
 */
import '../../mocks/database.mock';
import * as realService from '../../../apps/backend/services/library.service';
import { createLibraryServiceMock } from '../../mocks/library-service.mock';

describe('createLibraryServiceMock', () => {
  const mock = createLibraryServiceMock() as Record<string, unknown>;
  const realExports = Object.entries(realService);

  it('has every runtime export of library.service', () => {
    const missing = realExports.map(([name]) => name).filter((name) => !(name in mock));
    expect(missing).toEqual([]);
  });

  it('defines every value export, so none reads as undefined', () => {
    const undefinedValues = realExports.map(([name]) => name).filter((name) => mock[name] === undefined);
    expect(undefinedValues).toEqual([]);
  });

  it('stubs real functions with functions and real constants with non-functions', () => {
    const kindMismatches = realExports
      .filter(([name, value]) => typeof value !== 'function' && typeof mock[name] === 'function')
      .map(([name]) => name);
    expect(kindMismatches).toEqual([]);
  });

  it('lets a suite override a stub with its own handle', () => {
    const handle = jest.fn();
    expect(createLibraryServiceMock({ getAlbumFromDB: handle }).getAlbumFromDB).toBe(handle);
  });
});
