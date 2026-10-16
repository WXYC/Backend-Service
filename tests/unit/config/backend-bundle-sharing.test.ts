import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

interface MetaOutput {
  imports: { path: string; kind: string; external?: boolean }[];
  inputs: Record<string, { bytesInOutput: number }>;
}

// Builds the real backend tsup config (BS#2975). instrument.js is a preload
// that app.js never imports, so without a shared chunk each app module both
// reach is bundled twice and `instanceof` against app-defined classes (e.g.
// WxycError) is false across the two copies.
describe('backend bundle: modules shared by instrument.js and app.js', () => {
  const repoRoot = resolve(__dirname, '../../..');
  const backendDir = join(repoRoot, 'apps/backend');
  let outDir: string;
  let outputs: Record<string, MetaOutput>;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'backend-bundle-'));
    // Same invocation as `npm run build`, from the backend directory: tsup
    // reads that package.json to decide which dependencies stay external.
    execFileSync(
      join(repoRoot, 'node_modules/.bin/tsup'),
      ['--minify', '--metafile', '--out-dir', outDir, '--no-sourcemap', '--silent'],
      { cwd: backendDir, stdio: 'pipe' }
    );
    const meta = JSON.parse(readFileSync(join(outDir, 'metafile-esm.json'), 'utf-8'));
    outputs = Object.fromEntries(Object.entries<MetaOutput>(meta.outputs).filter(([file]) => file.endsWith('.js')));
  }, 240_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  const outputNamed = (name: string) => Object.keys(outputs).find((file) => file.endsWith(`/${name}`));

  it('bundles each first-party module into at most one output file', () => {
    const owners = new Map<string, string[]>();
    for (const [file, output] of Object.entries(outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (bytesInOutput > 0 && !input.includes('node_modules')) {
          owners.set(input, [...(owners.get(input) ?? []), file]);
        }
      }
    }
    const duplicated = [...owners].filter(([, files]) => files.length > 1).map(([input]) => input);
    expect(duplicated).toEqual([]);
  });

  it('keeps express and app.ts out of the preload static import closure', () => {
    const start = outputNamed('instrument.js');
    expect(start).toBeDefined();
    const seen = new Set<string>();
    const externals = new Set<string>();
    const inputs = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) {
        return;
      }
      seen.add(file);
      Object.keys(outputs[file].inputs).forEach((input) => inputs.add(input));
      for (const imp of outputs[file].imports) {
        if (imp.kind !== 'import-statement') {
          continue;
        }
        if (imp.external) {
          externals.add(imp.path);
        } else if (outputs[imp.path]) {
          visit(imp.path);
        }
      }
    };
    visit(start);
    // Positive control: the walk followed instrument.js into the shared chunk,
    // so the two assertions below cover the chunk too.
    expect(seen.size).toBeGreaterThan(1);
    expect([...inputs]).toContain('utils/error.ts');
    expect([...externals].filter((path) => path === 'express' || path.startsWith('express/'))).toEqual([]);
    expect([...inputs].filter((input) => input === 'app.ts')).toEqual([]);
  });

  // esbuild writes an entry's imports of shared chunks above the entry's own
  // imports, so without the tsup banner the chunk, and the @wxyc/lml-client it
  // imports, would evaluate before .env loads. ESM evaluates imports in source
  // order, so the first import in the file is the first module the preload runs.
  it('loads dotenv/config before any other module in instrument.js', () => {
    const source = readFileSync(join(outDir, 'instrument.js'), 'utf-8');
    const firstStatement = source.trimStart().split(';', 1)[0];
    expect(firstStatement).toMatch(/^import\s*['"]dotenv\/config['"]$/);
  });
});
