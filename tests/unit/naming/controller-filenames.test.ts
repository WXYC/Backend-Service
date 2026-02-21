import fs from 'fs';
import path from 'path';

const CONTROLLERS_DIR = path.resolve(__dirname, '../../../apps/backend/controllers');

describe('controller filenames', () => {
  it('should not contain misspelled "conroller" in any filename', () => {
    const files = fs.readdirSync(CONTROLLERS_DIR);
    const misspelled = files.filter((f) => /conroller/i.test(f));

    expect(misspelled).toEqual([]);
  });
});
