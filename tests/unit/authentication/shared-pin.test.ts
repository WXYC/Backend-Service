import { readFileSync } from 'node:fs';
import path from 'node:path';
// Required rather than imported: tests/tsconfig.json uses moduleResolution Node, which ignores package exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SpotlightRole, RequestLineMode } = require('@wxyc/shared/dtos');

const installedVersion = (): string => {
  const entry = require.resolve('@wxyc/shared');
  const root = entry.slice(0, entry.lastIndexOf(`${path.sep}dist${path.sep}`));
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
};

describe('@wxyc/shared pin', () => {
  it('resolves the 12.11.0 release', () => {
    expect(installedVersion()).toBe('12.11.0');
  });

  it('exposes the specialty-show DTO values', () => {
    // Runtime check: neither export exists in 5.4.0.
    expect(Object.keys(SpotlightRole).length).toBeGreaterThan(0);
    expect(Object.keys(RequestLineMode).length).toBeGreaterThan(0);
  });
});
