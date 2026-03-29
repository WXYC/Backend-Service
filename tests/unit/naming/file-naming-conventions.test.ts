import fs from 'fs';
import path from 'path';

const BACKEND_DIR = path.resolve(__dirname, '../../../apps/backend');

const NAMING_CONVENTIONS: Record<string, RegExp> = {
  controllers: /\.controller\.ts$/,
  services: /\.service\.ts$/,
  routes: /\.route\.ts$/,
};

describe('file naming conventions', () => {
  it.each(Object.entries(NAMING_CONVENTIONS))('%s/ files should match %s', (directory, pattern) => {
    const dirPath = path.join(BACKEND_DIR, directory);
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    const tsFiles = files.filter((f) => f.isFile() && f.name.endsWith('.ts'));
    const violations = tsFiles.filter((f) => !pattern.test(f.name));

    expect(violations.map((f) => f.name)).toEqual([]);
  });
});
