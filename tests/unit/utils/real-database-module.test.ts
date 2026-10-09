/**
 * Unit tests for the shared `@wxyc/database` module double
 * (tests/utils/real-database-module.ts).
 */
jest.unmock('drizzle-orm');

import { realDatabaseModule } from '../../utils/real-database-module';
import * as realSchema from '../../../shared/database/src/schema';
import * as nyTime from '../../../shared/database/src/ny-time';
import * as staffName from '../../../shared/database/src/staff-name';
import * as sqlstate from '../../../shared/database/src/sqlstate';

describe('realDatabaseModule', () => {
  const mod = realDatabaseModule();

  it('exposes the real schema, the ny-time, staff-name and sqlstate modules, and a db', () => {
    expect(mod.user).toBe(realSchema.user);
    expect(mod.rotationActiveSql).toBe(realSchema.rotationActiveSql);
    expect(typeof mod.staffNameSql).toBe('function');
    expect(typeof mod.readStaffName).toBe('function');
    for (const real of [nyTime, staffName, sqlstate]) {
      for (const key of Object.keys(real)) expect(mod[key]).toBe((real as Record<string, unknown>)[key]);
    }
    expect(mod.db).toBeDefined();
  });

  it('lets overrides win over the real exports, including db', () => {
    const spy = jest.fn();
    const db = { select: jest.fn() };
    const overridden = realDatabaseModule({ rotationActiveSql: spy, db });
    expect(overridden.rotationActiveSql).toBe(spy);
    expect(overridden.db).toBe(db);
    expect(overridden.user).toBe(realSchema.user);
  });
});
