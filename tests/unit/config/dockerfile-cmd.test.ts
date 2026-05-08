import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Dockerfile CMD invariant for Sentry --import chain', () => {
  it.each([
    ['auth', '../../../Dockerfile.auth'],
    ['backend', '../../../Dockerfile.backend'],
  ])(
    '%s Dockerfile CMD either delegates to npm start (which carries --import) or inlines --import directly',
    (_app, relPath) => {
      const dockerfile = readFileSync(resolve(__dirname, relPath), 'utf-8');
      const cmdMatch = dockerfile.match(/^CMD\s+(\[.+\]|.+)$/m);
      expect(cmdMatch).not.toBeNull();
      if (!cmdMatch) return;
      const cmd = cmdMatch[1];
      const delegatesToNpmStart = /"npm"\s*,\s*"start"\s*,\s*"--workspace=/.test(cmd);
      const inlinesImport = cmd.includes('--import') && cmd.includes('./dist/instrument.js');
      expect(delegatesToNpmStart || inlinesImport).toBe(true);
    }
  );
});
