/**
 * Source-level guards on `shared/database/src/streaming-merge-sql.ts` and its
 * `apps/enrichment-worker` re-export shim (BS#2693's lift).
 *
 * **This file deliberately imports NEITHER module under test.** That is the whole
 * reason it is separate from `streaming-merge-sql.test.ts`, and it is a correction
 * to a real weakness in the first draft: every violation these cases exist to catch
 * also makes the module fail to LOAD, so when the assertions lived alongside a real
 * `import` of the subject, jest reported `Tests: 0 total` and a stack trace from
 * inside `client.ts` or a duplicate-export syntax error. The violation was caught,
 * but the message pointed at the wrong thing — and a guard whose failure you have to
 * decode is most of the way to no guard at all.
 *
 * Reading the text instead of loading it means these three properties report
 * themselves by name even when the module is unloadable:
 *
 *   1. the module reaches `drizzle-orm` and nothing else — the side-effect-freedom
 *      BS#1945 extracted the first builder for, and the reason the subpath exists
 *      rather than a barrel re-export (`shared/database/src/index.ts` re-exports
 *      `client.ts`, which throws at import time on missing DB env vars);
 *   2. the locally-restated `StreamingResolutionStatus` still matches
 *      `@wxyc/shared`'s (`shared/database` imports no `@wxyc/*` package, so the
 *      union is restated there rather than imported);
 *   3. the shim re-exports rather than redefining — a second definition is the
 *      exact drift BS#1945 removed.
 *
 * Source-level is also the only option for (1) regardless: under jest the
 * `@wxyc/database` barrel is mapped to `tests/mocks/database.mock.ts` and so cannot
 * throw, which means a behavioural "importing it doesn't blow up" assertion would
 * pass even if the module imported the barrel. Same read-the-source approach as the
 * `tests/unit/database/schema.*.test.ts` family.
 */

import { readFileSync } from 'fs';
import path from 'path';

import { StreamingResolutionStatus as SharedStatus } from '@wxyc/shared/dtos';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const readSource = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), 'utf8');

const source = readSource('shared', 'database', 'src', 'streaming-merge-sql.ts');
const shimSource = readSource('apps', 'enrichment-worker', 'streaming-merge-sql.ts');

/**
 * Every module specifier a file reaches, in ANY form.
 *
 * Comments are stripped first, so a docstring's prose or a commented-out import can
 * neither create nor hide a match. Then FOUR forms are collected, not one:
 * `import … from 'x'`, bare side-effect `import 'x'`, `export … from 'x'` (a
 * re-export loads the module just as an import does), and `require('x')` /
 * `import('x')`.
 *
 * An earlier version matched only `import … from 'x';`, which left the hole open on
 * exactly the form that exists FOR its side effects: `import './client.js';`
 * satisfied "imports only drizzle-orm" while pulling in the pool constructor.
 */
const SPECIFIER_PATTERNS = [
  // `import … from 'x'` / `export … from 'x'` / `export * from 'x'`. The clause
  // between the keyword and `from` excludes quotes and `;` so this cannot run past
  // the end of its own statement, and each quantifier is bounded by its character
  // class rather than nested inside another.
  /\b(?:import|export)\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]/g,
  // Bare side-effect `import 'x'` — a quote directly after the keyword, which also
  // means it cannot match `import('x')` (that has a paren) or `import x from 'y'`.
  /\bimport\s*['"]([^'"]+)['"]/g,
  // `require('x')` and dynamic `import('x')`.
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const moduleSpecifiers = (text: string): string[] => {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return SPECIFIER_PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
};

describe('the specifier scanner itself', () => {
  // The assertions below are only as good as this function, and a regex that
  // silently matches nothing reads identical to a pass — so pin it directly.
  const scannerCases: Array<[string, string[]]> = [
    ["import { sql } from 'drizzle-orm';", ['drizzle-orm']],
    ["import './client.js';", ['./client.js']],
    ["export * from './index.js';", ['./index.js']],
    ["export { x } from './index.js';", ['./index.js']],
    ["const x = require('@wxyc/lml-client');", ['@wxyc/lml-client']],
    ["await import('@wxyc/observability');", ['@wxyc/observability']],
    ["// import './client.js';", []],
    ["/** prose mentioning import time and 'quoted' words */", []],
  ];

  it.each(scannerCases)('%s', (input, expected) => {
    expect(moduleSpecifiers(input)).toEqual(expected);
  });
});

describe('streaming-merge-sql import-time side effects', () => {
  const specifiers = moduleSpecifiers(source);

  it('imports only drizzle-orm, in any import form', () => {
    expect(specifiers).toEqual(['drizzle-orm']);
  });

  it('never reaches the pool-constructing client, directly or via the barrel', () => {
    // `client.ts` throws on missing DB_HOST/DB_NAME/DB_USERNAME/DB_PASSWORD, so
    // either route would make the builders un-importable without a database — and
    // un-`require`-able by `enrichment-worker-streaming-toctou.spec.js`.
    expect(specifiers).not.toContain('./client.js');
    expect(specifiers).not.toContain('./index.js');
    expect(specifiers.filter((specifier) => specifier.startsWith('@wxyc/'))).toEqual([]);
  });
});

describe('locally-restated StreamingResolutionStatus', () => {
  // The union is read OUT OF THE MODULE'S SOURCE rather than re-typed here. A third
  // hand-copy would only ever compare itself to `@wxyc/shared` and would pass while
  // the module drifted — which is exactly what an earlier draft did, verified by
  // adding a fourth value to the module and watching every case stay green. A
  // type-level `extends` assertion is no use in this tier either
  // (`isolatedModules: true` → ts-jest transpiles without checking, so
  // `const x: false = true` compiles); the type-level half of this guard lives in
  // `apps/enrichment-worker/streaming-merge-sql.ts`, inside `npm run typecheck`.
  const unionMatch = /^export type StreamingResolutionStatus = (.+);$/m.exec(source);
  const declaredValues = (unionMatch?.[1] ?? '').split('|').map((part) => part.trim().replace(/^'|'$/g, ''));

  it('declares the union in the shape this guard can read', () => {
    // Fail loudly on a reformat rather than silently matching nothing and comparing
    // two empty lists.
    expect(unionMatch).not.toBeNull();
    expect(declaredValues.length).toBeGreaterThan(0);
  });

  it('declares exactly the values @wxyc/shared does', () => {
    expect([...declaredValues].sort()).toEqual(Object.values(SharedStatus).sort());
  });
});

describe('the apps/enrichment-worker re-export shim', () => {
  it('declares none of the three exported names', () => {
    // NOT `expect(shim.NO_FALLBACK).toBe(NO_FALLBACK)`, which cannot fail: both
    // sides are `null`, so `Object.is` passes even if the shim redeclared the
    // constant. Reference identity only bites on the two exports that happen not to
    // be primitives, so the no-second-definition property is asserted structurally.
    for (const name of ['NO_FALLBACK', 'buildStreamingFieldConflictSet', 'fillOrUpgradeSearchUrl']) {
      expect(shimSource).not.toMatch(new RegExp(String.raw`(?:const|let|var|function)\s+${name}\b`));
    }
  });

  it('routes all three names out of the shared subpath', () => {
    expect(moduleSpecifiers(shimSource)).toContain('@wxyc/database/streaming-merge-sql');
    expect(shimSource).toMatch(/export\s*\{[\s\S]*?\}\s*from\s*'@wxyc\/database\/streaming-merge-sql'/);
  });
});
