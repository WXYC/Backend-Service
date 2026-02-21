import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../shared/database/src/migrations/migration_script.mjs'
);

const EXPECTED_MIGRATIONS_FOLDER = 'shared/database/src/migrations';

describe('migration_script.mjs', () => {
  it('should reference the correct migrations folder path', () => {
    const content = fs.readFileSync(MIGRATION_SCRIPT_PATH, 'utf-8');
    const match = content.match(/migrationsFolder:\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();

    const migrationsFolder = match![1];
    expect(migrationsFolder).toBe(EXPECTED_MIGRATIONS_FOLDER);
  });

  it('should point to a directory that exists relative to the workspace root', () => {
    const workspaceRoot = path.resolve(__dirname, '../../..');
    const resolvedPath = path.resolve(workspaceRoot, EXPECTED_MIGRATIONS_FOLDER);
    expect(fs.existsSync(resolvedPath)).toBe(true);
  });
});
