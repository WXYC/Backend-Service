// Compile-time guard for `flowsheet.linkage_source` (BS#3078). Never imported or bundled: `tsc --noEmit` (npm run
// typecheck, strict) is what enforces it. The Jest suites run ts-jest with `isolatedModules` and strict off, which
// does not report an unused `@ts-expect-error`, so a type-level check there would pass even if the guard vanished.
import type { NewFSEntry } from './schema.js';

export const accepted: NewFSEntry['linkage_source'] = 'direct_text_match';

// @ts-expect-error 'direct_text_mach' is not a LinkageSource
export const typo: NewFSEntry['linkage_source'] = 'direct_text_mach';

// @ts-expect-error a non-member string fails in an insert row
export const row: NewFSEntry = { show_id: 1, linkage_source: 'bogus' };
