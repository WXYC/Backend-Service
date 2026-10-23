/**
 * Pin the worker cap and idle-memory recycle in `jest.unit.config.ts` (BS#3668).
 *
 * Uncapped, `npm run test:unit` starts one worker per core minus one and peaks
 * at about 4.5 GB summed RSS; 3 workers recycled past 512 MB peak at about
 * 2.2 GB. Dropping either setting silently restores the large footprint, so a
 * source-grep test holds both in place, in the style of
 * `ci-unit-tests-full-suite.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const configPath = path.resolve(__dirname, '../../../jest.unit.config.ts');
const config = fs.readFileSync(configPath, 'utf-8');

describe('jest.unit.config.ts memory settings', () => {
  it.each([
    ['maxWorkers', /^\s*maxWorkers:\s*3,/m],
    ['workerIdleMemoryLimit', /^\s*workerIdleMemoryLimit:\s*'512MB',/m],
  ])('sets %s', (_name, pattern) => {
    expect(config).toMatch(pattern);
  });
});
