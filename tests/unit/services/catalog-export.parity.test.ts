/**
 * Drift guard: the private `CatalogExportRow` (the `GET /library/catalog` wire
 * shape, owned by `apps/backend/services/catalog-export.service.ts`) must stay
 * in lockstep with the cross-repo SSOT `CatalogExportRow` published by
 * `@wxyc/shared/dtos` (generated from `wxyc-shared/api.yaml`, added in
 * WXYC/wxyc-shared#186). The SSOT type feeds the iOS / Kotlin / dj-site codegen,
 * so a field added on one side but not the other ships a wrong on-device clone.
 *
 * These two definitions already drifted once (#1468 shipped the endpoint without
 * ever propagating its row shape to the SSOT), which is why this guard exists
 * (BS#1477). Nothing else keeps them in agreement.
 *
 * # What this guards
 *
 *   1. KEY SET (field add/remove). The two definitions must declare exactly the
 *      same fields. Adding/removing a field on exactly one side fails this test.
 *   2. `rotation_bin` stays a RAW nullable string on both sides — NOT re-narrowed
 *      to the `RotationBin` ("H" | "M" | "L" | "S") enum. This is the specific
 *      drift wxyc-shared#186 acceptance criterion G1 calls out: the endpoint
 *      ships the raw current-rotation bin so a value outside the nominal cohorts
 *      (e.g. 'N') can't break a strict-enum decoder on device. A bare key-set
 *      check would not catch an enum re-narrowing, so it is pinned explicitly.
 *
 * # Pending allowlist (`PENDING_SSOT_RELEASE_KEYS`)
 *
 * A key can land on wxyc-shared `main`'s contract before any `@wxyc/shared`
 * release carries it, while Backend (pinned to an older major) must start
 * emitting it. `PENDING_SSOT_RELEASE_KEYS` names exactly those keys
 * (`code_volume_letters`: WXYC/wxyc-shared#548, BS#2826; `code_comp_letter`: WXYC/wxyc-shared#549, BS#2835). It is ONE-DIRECTIONAL:
 * it tolerates only the private type having a key the INSTALLED package lacks.
 * It never tolerates the reverse (an SSOT key missing from Backend), and any
 * other difference still fails. A self-check fails the suite once an allowlisted
 * key shows up in the installed SSOT, telling you to delete it from the list.
 * WXYC/Backend-Service#2884 publishes/bumps the release and removes the
 * allowlist (and the matching `Omit` on the compile-time assertion below).
 *
 * # What this does NOT guard
 *
 * Per wxyc-shared#186 G1: this is field add/remove + the one `rotation_bin`
 * type pin, NOT full type / `required` / enum parity for every field. The SSOT
 * marks several fields optional (no `required:` entry in the schema) where the
 * private type marks them required; that `?`-vs-required difference is expected
 * and deliberately tolerated here (key-set comparison strips the `?`). It also
 * does NOT guard the third hand-maintained copy in `app.yaml` (BS#1479).
 *
 * # Why source-grep, not a pure type-level assertion
 *
 * The unit suite runs through ts-jest with `isolatedModules: true`
 * (`tests/tsconfig.json`), which transpiles per file WITHOUT type-checking — a
 * `tsc`-level type error does not fail the jest run. So the runtime guard that
 * actually fails CI reads each definition from its source-of-truth artifact as
 * text (the private `.ts`, the installed SSOT `.d.ts`) and compares the
 * extracted key sets — the same idiom as the other guards in
 * `tests/unit/scripts/` and `tests/unit/config/healthcheck-shape.test.ts`.
 *
 * The compile-time `KeysEqual` / `rotation_bin` assertions below document the
 * same contract at the type level and bite under a real `tsc` pass (the
 * `apps/backend` typecheck already forces `projectRow` to mirror the private
 * type); they are belt-and-suspenders, not the primary signal.
 *
 * # Copyable template
 *
 * This is the reference guard for the next bulk endpoint that hand-defines its
 * wire shape instead of consuming the SSOT type. Copy it, swap the two source
 * artifacts and the type name, keep the same two-layer (runtime grep +
 * compile-time assertion) structure.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import type {
  CatalogExportRow as PrivateRow,
  CompilationTrackExportRow as PrivateCtaRow,
} from '../../../apps/backend/services/catalog-export.service';
import type { CatalogExportRow as SharedRow, CatalogCompilationTrackRow as SharedCtaRow } from '@wxyc/shared/dtos';

// ---------------------------------------------------------------------------
// Compile-time contract (belt-and-suspenders; enforced by a real `tsc`, e.g.
// the `apps/backend` typecheck path, NOT by the ts-jest unit run).
// ---------------------------------------------------------------------------

// Mutual key-set equality: resolves to `true` only when both types declare the
// exact same key union, `never` otherwise. (optional-vs-required does not change
// `keyof`, so this tolerates the `?` differences the SSOT carries.)
//
// `code_volume_letters` and `code_comp_letter` are excluded from the private side
// while they are pending (see PENDING_SSOT_RELEASE_KEYS below): the installed
// @wxyc/shared 5.4.0 lacks them. Remove the `Omit` with the allowlist in
// WXYC/Backend-Service#2884.
type KeysEqual<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
const _keysAgree: KeysEqual<Omit<PrivateRow, 'code_volume_letters' | 'code_comp_letter'>, SharedRow> = true;
void _keysAgree;

// `rotation_bin` must stay assignable from a raw string on BOTH sides. If
// either were re-narrowed to the `RotationBin` ("H" | "M" | "L" | "S") enum,
// the literal below would stop being assignable and this would fail to compile.
//
// The point is forward compatibility: a bin added server-side ahead of its
// clients must not fail the whole NDJSON export. BS#2173 note — this used to
// use 'N' and cite it as "the SSOT doc's own example". 'N' was never a server
// bin (it is flowsheet entry-type 5, "new vinyl, not yet in rotation") and is
// gone from `freq_enum` as of migration 0150, so the placeholder is now an
// openly hypothetical value rather than one implied to exist.
const _privateBinAcceptsRawString: PrivateRow['rotation_bin'] = 'SOME_FUTURE_BIN';
const _sharedBinAcceptsRawString: SharedRow['rotation_bin'] = 'SOME_FUTURE_BIN';
void _privateBinAcceptsRawString;
void _sharedBinAcceptsRawString;

// Same mutual key-set equality for the BS#1965 CTA export pair.
const _ctaKeysAgree: KeysEqual<PrivateCtaRow, SharedCtaRow> = true;
void _ctaKeysAgree;

// ---------------------------------------------------------------------------
// Runtime contract (the assertion that actually fails CI on drift).
// ---------------------------------------------------------------------------

/**
 * Keys Backend emits that are already on wxyc-shared `main`'s `CatalogExportRow`
 * contract but are missing from the INSTALLED `@wxyc/shared`, because no release
 * carries them yet. One-directional: tolerated only as present-private /
 * absent-SSOT. Keep it minimal; WXYC/Backend-Service#2884 empties and removes it.
 * `code_volume_letters`: WXYC/wxyc-shared#548, WXYC/Backend-Service#2826.
 * `code_comp_letter`: WXYC/wxyc-shared#549, WXYC/Backend-Service#2835.
 */
const PENDING_SSOT_RELEASE_KEYS: readonly string[] = ['code_volume_letters', 'code_comp_letter'];

/**
 * Compare key sets, tolerating only `pending` keys that the private side has and
 * the SSOT lacks. Returns the unexplained differences plus any `pending` key the
 * SSOT already carries (stale allowlist entries).
 */
function diffKeySets(privateKeys: string[], ssotKeys: string[], pending: readonly string[]) {
  const stalePending = pending.filter((k) => ssotKeys.includes(k));
  const tolerated = new Set(pending.filter((k) => privateKeys.includes(k) && !ssotKeys.includes(k)));
  return {
    stalePending,
    privateOnly: privateKeys.filter((k) => !ssotKeys.includes(k) && !tolerated.has(k)),
    ssotOnly: ssotKeys.filter((k) => !privateKeys.includes(k)),
  };
}

/**
 * Field names declared in the private `export type CatalogExportRow = { ... }`
 * block of `apps/backend/services/catalog-export.service.ts`.
 */
function extractPrivateRowKeys(typeName: string): string[] {
  const servicePath = resolve(__dirname, '../../../apps/backend/services/catalog-export.service.ts');
  const source = readFileSync(servicePath, 'utf-8');
  const block = source.match(new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\};`))?.[1];
  if (!block) {
    throw new Error(`private \`export type ${typeName} = { ... }\` block not found in catalog-export.service.ts`);
  }
  return extractObjectTypeKeys(block);
}

/**
 * Field names declared in the SSOT `CatalogExportRow` schema, read from the
 * actually-installed `@wxyc/shared` package. We resolve the `@wxyc/shared/dtos`
 * entry, then read the sibling bundled `index-*.d.ts` (content-hashed name) that
 * carries the full `components['schemas']['CatalogExportRow']` body — the
 * `dtos/index.d.ts` itself is only a re-export. Reading the installed package
 * (not a checked-in copy) makes the `@wxyc/shared` dependency bump load-bearing:
 * a version without `CatalogExportRow` makes this throw.
 */
function extractSsotRowKeys(schemaName: string): string[] {
  const block = readSsotRowBlock(schemaName);
  return extractObjectTypeKeys(block);
}

/**
 * Locate and return the raw text of the SSOT `CatalogExportRow: { ... }` schema
 * block from the installed `@wxyc/shared` bundled declaration file.
 */
function readSsotRowBlock(schemaName: string): string {
  const require = createRequire(__filename);
  // dist/dtos/index.js -> dist/
  const distDir = dirname(dirname(require.resolve('@wxyc/shared/dtos')));
  const bundle = readdirSync(distDir).find((f) => /^index-.*\.d\.ts$/.test(f));
  if (!bundle) {
    throw new Error(`bundled @wxyc/shared index-*.d.ts not found in ${distDir}`);
  }
  const decl = readFileSync(join(distDir, bundle), 'utf-8');
  // The schema block: `CatalogExportRow: { ... };` under components['schemas'].
  // Balance braces from the opening `{` so nested members don't end it early.
  const startToken = `${schemaName}: {`;
  const startIdx = decl.indexOf(startToken);
  if (startIdx === -1) {
    throw new Error(
      `SSOT ${schemaName} schema not found in ${bundle}. ` + 'Is the installed @wxyc/shared new enough to carry it?'
    );
  }
  const braceOpen = startIdx + startToken.length - 1;
  let depth = 0;
  let i = braceOpen;
  for (; i < decl.length; i++) {
    if (decl[i] === '{') depth++;
    else if (decl[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return decl.slice(braceOpen + 1, i);
}

/**
 * Pull the top-level field names out of a TS object-type body. Handles the
 * `name?:` optional marker (stripped), skips JSDoc / `//` comments, and ignores
 * nested object members by only taking keys at the body's outermost depth.
 */
function extractObjectTypeKeys(body: string): string[] {
  const keys = new Set<string>();
  let depth = 0;
  let inBlockComment = false;

  for (const rawLine of body.split('\n')) {
    let line = rawLine;

    // Strip block comments (JSDoc) spanning the line or whole lines.
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // Remove inline block comments and detect an unterminated one.
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const openComment = line.indexOf('/*');
    if (openComment !== -1) {
      line = line.slice(0, openComment);
      inBlockComment = true;
    }
    // Strip line comments.
    line = line.replace(/\/\/.*$/, '');

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Match a field declaration only at the outermost depth of the body.
    if (depth === 0) {
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
      if (m) {
        keys.add(m[1]);
      }
    }

    // Track nesting AFTER attempting the match so a `name: {` line still
    // registers `name` before we descend.
    for (const ch of trimmed) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }

  return [...keys].sort();
}

describe('CatalogExportRow parity: private TS type vs @wxyc/shared SSOT schema (BS#1477)', () => {
  const privateKeys = extractPrivateRowKeys('CatalogExportRow');
  const ssotKeys = extractSsotRowKeys('CatalogExportRow');

  it('extracts a non-trivial key set from each side (sanity)', () => {
    // Guards against an extractor that silently matches nothing and lets a real
    // drift pass as two empty, "equal" sets.
    expect(privateKeys.length).toBeGreaterThanOrEqual(10);
    expect(ssotKeys.length).toBeGreaterThanOrEqual(10);
  });

  it('the private CatalogExportRow key set equals the @wxyc/shared SSOT key set', () => {
    // Adding/removing a field on exactly one side fails here. To fix: propagate
    // the field to BOTH the private type and wxyc-shared/api.yaml (then publish
    // a new @wxyc/shared and bump the dependency).
    // Only PENDING_SSOT_RELEASE_KEYS may be present-private / absent-SSOT.
    const { privateOnly, ssotOnly } = diffKeySets(privateKeys, ssotKeys, PENDING_SSOT_RELEASE_KEYS);
    expect({ privateOnly, ssotOnly }).toEqual({ privateOnly: [], ssotOnly: [] });
  });

  it('PENDING_SSOT_RELEASE_KEYS has no entry the installed @wxyc/shared already carries', () => {
    // Anti-rot: once a release with the key is installed, the allowlist must go.
    const { stalePending } = diffKeySets(privateKeys, ssotKeys, PENDING_SSOT_RELEASE_KEYS);
    if (stalePending.length > 0) {
      throw new Error(
        `${stalePending.join(', ')} is now in the installed @wxyc/shared CatalogExportRow: remove it from PENDING_SSOT_RELEASE_KEYS (and the Omit on the KeysEqual assertion), per WXYC/Backend-Service#2884`
      );
    }
  });

  describe('diffKeySets (allowlist semantics)', () => {
    const pending = ['p'];
    it('tolerates a pending key present only on the private side', () => {
      expect(diffKeySets(['a', 'p'], ['a'], pending)).toEqual({ stalePending: [], privateOnly: [], ssotOnly: [] });
    });
    it('still reports a non-pending private-only key', () => {
      expect(diffKeySets(['a', 'p', 'x'], ['a'], pending).privateOnly).toEqual(['x']);
    });
    it('never tolerates an SSOT key missing from the private side, even if pending', () => {
      expect(diffKeySets(['a'], ['a', 'p'], pending)).toMatchObject({ stalePending: ['p'], ssotOnly: ['p'] });
      expect(diffKeySets(['a'], ['a', 'y'], pending).ssotOnly).toEqual(['y']);
    });
    it('flags a pending key the SSOT now carries as stale', () => {
      expect(diffKeySets(['a', 'p'], ['a', 'p'], pending).stalePending).toEqual(['p']);
    });
  });

  it('pins rotation_bin as a raw nullable string on the SSOT side (not the RotationBin enum)', () => {
    // wxyc-shared#186 G1 + the enum drift that motivated this ticket: the export
    // ships the RAW rotation bin so an off-cohort value can't break a strict
    // enum decoder. If api.yaml ever re-narrows rotation_bin to RotationBin, the
    // generated type references the enum and this fails.
    const ssotBlock = readSsotRowBlock('CatalogExportRow');
    const binLine = ssotBlock.split('\n').find((l) => /\brotation_bin\b\s*\??\s*:/.test(l));
    expect(binLine).toBeDefined();
    expect(binLine).toMatch(/:\s*string\b/);
    expect(binLine).not.toMatch(/RotationBin/);
  });

  it('pins rotation_bin as `string | null` on the private side', () => {
    const servicePath = resolve(__dirname, '../../../apps/backend/services/catalog-export.service.ts');
    const source = readFileSync(servicePath, 'utf-8');
    const block = source.match(/export type CatalogExportRow = \{([\s\S]*?)\};/)?.[1] ?? '';
    const binLine = block.split('\n').find((l) => /\brotation_bin\b\s*:/.test(l));
    expect(binLine).toBeDefined();
    expect(binLine).toMatch(/rotation_bin\s*:\s*string\s*\|\s*null\s*;/);
    expect(binLine).not.toMatch(/RotationBin/);
  });
});

describe('CompilationTrackExportRow parity: private TS type vs @wxyc/shared SSOT schema (BS#1965)', () => {
  // Same guard, same reasons, for the CTA export's hand-defined wire shape. The
  // docblock above nominates itself as the template for "the next bulk endpoint
  // that hand-defines its wire shape instead of consuming the SSOT type" — this
  // is that endpoint (GET /library/catalog/compilation-tracks), so the extractors
  // are parameterized and reused rather than copied.
  //
  // The drift this catches is worse here than for CatalogExportRow, because the
  // consumer is a byte-parity gate: the library.db producer (discogs-etl#351)
  // writes these three columns into SQLite and discogs-etl#346 diffs the result
  // against the legacy MySQL artifact. A field added on one side only shifts the
  // produced table's shape with nothing else in the chain to notice.
  // Same "what this does NOT guard" caveat as above applies: the SSOT marks
  // `track_title` optional (no `required:` entry) where the private type marks it
  // required. That `?`-vs-required difference is expected and tolerated — the
  // key-set comparison strips the `?`. The third hand-maintained copy in
  // `app.yaml` is still unguarded (BS#1479).
  const privateKeys = extractPrivateRowKeys('CompilationTrackExportRow');
  const ssotKeys = extractSsotRowKeys('CatalogCompilationTrackRow');

  it('extracts a non-trivial key set from each side (sanity)', () => {
    // The CTA row is deliberately narrow (3 columns), so the floor is 3 rather
    // than the 10 the wide catalog row uses. Still guards an extractor that
    // silently matches nothing and lets drift pass as two empty, "equal" sets.
    expect(privateKeys.length).toBeGreaterThanOrEqual(3);
    expect(ssotKeys.length).toBeGreaterThanOrEqual(3);
  });

  it('the private CompilationTrackExportRow key set equals the SSOT CatalogCompilationTrackRow key set', () => {
    expect(privateKeys).toEqual(ssotKeys);
  });

  it('carries exactly the three library.db CTA columns — no id / track_position / library_id leak', () => {
    // library.db's compilation_track_artist table has 3 columns. The BS serial
    // CTA `id`, the serial `library_id` (the export is keyed on
    // legacy_release_id instead), and `track_position` are all deliberately
    // dropped; shipping any of them breaks parity with the legacy artifact.
    expect(privateKeys).toEqual(['artist_name', 'legacy_release_id', 'track_title']);
    for (const leaked of ['id', 'library_id', 'track_position']) {
      expect(privateKeys).not.toContain(leaked);
      expect(ssotKeys).not.toContain(leaked);
    }
  });
});
