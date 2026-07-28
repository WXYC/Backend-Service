#!/usr/bin/env node
/**
 * Enforces the BS→LML caller-classification invariant from BS#1826 (Step 4).
 *
 * `shared/lml-client/src/policy.ts` maps every registered `caller` label to
 * a traffic class (timeout/budget/fallback). `apps/**`/`shared/**` get this
 * enforced at COMPILE time: budget-bearing methods type `caller` as the
 * `LmlCaller` union, so a mistyped or unregistered label fails `tsc`. But
 * `jobs/**` is NOT covered by `npm run typecheck` (repo convention — see
 * `docs/env-vars.md` / CLAUDE.md's testing-scope note), so a job can pass a
 * bare `string` (or a `caller: JOB_NAME` const it forgot to register) and
 * nothing catches it before it reaches production. This script is that
 * backstop. It also catches the half of the acceptance criterion the
 * compiler structurally can't: a call that OMITS `caller` entirely has no
 * `caller:` token for a substring grep to match — so this script keys on the
 * call-EXPRESSIONS to the caller-aware `@wxyc/lml-client` methods, not on a
 * `caller:` substring search.
 *
 * Caller-aware methods (confirmed against `shared/lml-client/src/index.ts`,
 * BS#1826 PR 2): `lookupMetadata`, `lookupBySong`, `bulkLookupMetadata`,
 * `searchLibrary`, `checkStreamingAvailability`, `getRelease`,
 * `getArtistDetails`, `resolveEntity`, `searchTrackReleases`,
 * `resolveArtistNamesBulk`, `fetchArtistGenresBulk`. Three exports take NO
 * `caller` parameter at all and are deliberately excluded from scanning:
 * `resolveIdentity` / `refreshForIdentities` (fixed env-driven timeouts, no
 * per-caller policy hook) and `validateTrackOnRelease` (no options object).
 *
 * `caller` PRESENCE is required — in both `apps/**`/`shared/**` AND
 * `jobs/**` — on only 3 of the 11 methods (`bulkLookupMetadata`,
 * `searchLibrary`, `checkStreamingAvailability`, mirroring their
 * type-required `caller` in `index.ts`'s JSDoc). The other 8 keep `caller`
 * optional everywhere, including in `jobs/**`: several documented call
 * sites (`proxy.controller.ts`'s bare `getArtistDetails(id)`,
 * `concerts-poster-enrichment/job.ts`'s bare `getArtistDetails(discogsArtistId)`)
 * predate this PR and are out of its migration scope, and inventing a
 * jobs-only presence requirement these pre-existing call sites don't meet
 * would make the guard fail against the current, correctly-migrated tree.
 * Presence is therefore governed by the method's own contract, not by which
 * directory the call lives in. What DOES differ by directory is WHICH
 * caller VALUES are trusted once `caller` is present — see the next section.
 *
 * Caller-value resolution: a call may pass a string literal
 * (`caller: 'proxy-library-search'`), a same-file local `const` string
 * literal (the `caller: JOB_NAME` pattern every `jobs/*` cron uses), or an
 * unresolvable expression (e.g. `caller: options?.caller`, a forwarding
 * pass-through). The last case is a real "cannot statically verify this
 * label" situation:
 *
 *   - In `jobs/**`, this is a FAILURE — the plan is explicit that a
 *     statically-unresolvable caller in an untypechecked file must not
 *     silently pass ("register the label" is the fix: use a literal or a
 *     same-file `const`).
 *   - In `apps/**`/`shared/**`, this is allowed — `LookupOptions.caller` /
 *     `CoordinatorLookupOptions.caller` are typed `LmlCaller` at their
 *     declaration, so a forwarded `options?.caller` is already
 *     compiler-verified to be a valid label (or `undefined`) at its own
 *     call site; this script does not re-derive that proof.
 *
 * Aliased/namespace-import evasion (jobs/** only): a plain method-name scan
 * would miss `import { bulkLookupMetadata as blm } from '@wxyc/lml-client'`
 * then `blm(...)`, or `import * as lml from '@wxyc/lml-client'` then
 * `lml.bulkLookupMetadata(...)`. Named-import aliasing is a normal,
 * widespread, LEGITIMATE convention in this codebase (`lookupMetadata as
 * sharedLookupMetadata` in half a dozen jobs' `lml-fetch.ts` shims,
 * `createLmlLimiter as createSharedLmlLimiter` in every job's
 * `lml-limiter.ts`), so banning it outright (a literal reading of the plan)
 * would fail on the current, correctly-migrated tree. Instead this script
 * RESOLVES named-import aliases AND namespace-qualified calls back to their
 * canonical method name and enforces the same checks through them — a
 * strictly stronger guarantee than "ban aliasing": it still catches the
 * described evasion (a bogus/absent caller reaching LML via a renamed
 * import) while not flagging the many renames that already correctly set
 * `caller` at their own call site. A bare `import * as ns from
 * '@wxyc/lml-client'` namespace import in jobs/** IS still flagged as a
 * failure on its own — unlike a named-import rename (which the resolver
 * fully tracks), a namespace import has no enumerable specifier list, so a
 * future method added to the client could slip past this script's
 * `ns.<method>(` scan silently; there is no legitimate reason for a job to
 * import the whole module namespace instead of the names it uses.
 *
 * Wired into CI as the "LML caller classification (policy invariant)" step
 * in `.github/workflows/test.yml`, next to "legacy_entry_id writes" (whose
 * three-use-invariant script this one's structure mirrors).
 *
 * BS#1842: `TYPE_REQUIRED_METHODS` / `TYPE_OPTIONAL_METHODS` below are still a
 * hardcoded list — but before scanning any call site, `main()` runs a
 * drift-check (`checkMethodListDrift`) that DERIVES the same set from
 * `shared/lml-client/src/index.ts` itself (which exported function
 * signatures actually accept a `caller` field, by direct inline presence, a
 * `Pick<..., 'caller'>` literal, or a reference to a type this file's own
 * `interface`/`type` declarations give a `caller` field) and fails loudly on
 * any mismatch. A new caller-aware method added to `index.ts` without a
 * matching entry here — the exact gap this issue collects — now fails CI
 * with a tooling error instead of silently scanning nothing for it.
 *
 * Exit codes:
 *   0 — every matched call site is classified correctly.
 *   1 — one or more violations found (missing caller / unregistered caller /
 *       unresolvable caller in jobs/** / a namespace import of
 *       @wxyc/lml-client in jobs/**).
 *   2 — tooling error: couldn't load `ALL_LML_CALLERS` from
 *       `shared/lml-client/src/policy.ts` (the single source of truth this
 *       script parses rather than hardcoding a second copy of the list),
 *       couldn't read `index.ts`, or the BS#1842 method-list drift-check
 *       found a caller-aware export this script doesn't track (or a tracked
 *       method index.ts no longer marks caller-aware).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { isInvokedDirectly } from './lib/main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const POLICY_PATH = resolve(REPO_ROOT, 'shared/lml-client/src/policy.ts');
const INDEX_PATH = resolve(REPO_ROOT, 'shared/lml-client/src/index.ts');

// The 11 caller-aware `@wxyc/lml-client` exports, split by whether `caller`
// is REQUIRED at the type level (see this file's header doc). Deliberately
// excludes `resolveIdentity`, `refreshForIdentities`, `validateTrackOnRelease`
// — none of the three accept a `caller` parameter at all.
const TYPE_REQUIRED_METHODS = new Set(['bulkLookupMetadata', 'searchLibrary', 'checkStreamingAvailability']);
const TYPE_OPTIONAL_METHODS = new Set([
  'lookupMetadata',
  'lookupBySong',
  'getRelease',
  'getArtistDetails',
  'resolveEntity',
  'searchTrackReleases',
  'resolveArtistNamesBulk',
  'fetchArtistGenresBulk',
]);
const ALL_METHODS = new Set([...TYPE_REQUIRED_METHODS, ...TYPE_OPTIONAL_METHODS]);

const SOURCE_ROOTS = ['apps', 'jobs'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'tests', '__tests__']);
const SKIP_FILE_SUFFIXES = ['.d.ts', '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** Parse `ALL_LML_CALLERS` straight out of `policy.ts` — no second copy of the list. */
function loadRegisteredCallers() {
  let src;
  try {
    src = readFileSync(POLICY_PATH, 'utf-8');
  } catch (err) {
    console.error(`FAIL(tooling): could not read ${relative(REPO_ROOT, POLICY_PATH)}: ${err.message}`);
    process.exit(2);
  }
  // Blank comments before extracting the block/tokens so prose apostrophes
  // (e.g. "this label's guard run" / "the plan's ... table") can't pair up
  // across lines into a bogus multi-line "string" token — the parse must be
  // authoritative, exactly the real string literals in ALL_LML_CALLERS.
  const commentsBlanked = blankComments(src);
  const block = commentsBlanked.match(/export const ALL_LML_CALLERS = \[([\s\S]*?)\]\s*as const;/);
  if (!block) {
    console.error(
      `FAIL(tooling): could not find "export const ALL_LML_CALLERS = [...] as const;" in ${relative(REPO_ROOT, POLICY_PATH)}. ` +
        'Has the export been renamed or reshaped?'
    );
    process.exit(2);
  }
  const callers = [...block[1].matchAll(/'([^'\\]+)'/g)].map((m) => m[1]);
  if (callers.length === 0) {
    console.error('FAIL(tooling): parsed ALL_LML_CALLERS as empty — parsing bug or the table was emptied.');
    process.exit(2);
  }
  return new Set(callers);
}

/** Read `shared/lml-client/src/index.ts` — the source the BS#1842 drift-check parses. */
function loadIndexSource() {
  try {
    return readFileSync(INDEX_PATH, 'utf-8');
  } catch (err) {
    console.error(`FAIL(tooling): could not read ${relative(REPO_ROOT, INDEX_PATH)}: ${err.message}`);
    process.exit(2);
  }
}

function listSourceFiles(rootRelativePath) {
  const absRoot = join(REPO_ROOT, rootRelativePath);
  let stat;
  try {
    stat = statSync(absRoot);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const out = [];
  walk(absRoot, out);
  return out;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const name = entry.name;
      if (SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s))) continue;
      if (!SOURCE_EXTENSIONS.some((s) => name.endsWith(s))) continue;
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * Blank out comments (line + block) while preserving string length and
 * newline positions, so downstream regex offsets stay valid against the
 * ORIGINAL source and a JSDoc mention like `` `getArtistDetails(id)` `` (a
 * prose reference, not a call) can't masquerade as a call site.
 */
function blankComments(content) {
  let out = '';
  let inString = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        i++;
        out += content[i] ?? '';
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      out += c;
      continue;
    }
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      const end = nl === -1 ? content.length : nl;
      out += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (c === '/' && content[i + 1] === '*') {
      const closeIdx = content.indexOf('*/', i + 2);
      const end = closeIdx === -1 ? content.length : closeIdx + 2;
      for (let j = i; j < end; j++) out += content[j] === '\n' ? '\n' : ' ';
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Blank both comments (line + block) AND the CONTENTS of string literals
 * (quote delimiters kept, interior characters replaced with spaces), while
 * preserving overall length and newline positions so every offset computed
 * against this copy lines up 1:1 with the ORIGINAL `content`.
 *
 * This is the single scanning surface used to DETECT things (call sites, and
 * whether a `caller:` argument is present) — never to read a literal's real
 * VALUE. Two false-result classes this closes, both rooted in the old
 * two-copy split (`codeOnly` blanked comments but kept strings; call-site
 * detection also used it, and args were re-extracted from raw `content`):
 *
 *   - A `caller:` token sitting inside a COMMENT within an argument list no
 *     longer has a colon-then-quote shape once comments are blanked, so a
 *     caller-less call can't hide behind a commented-out `caller:` example.
 *   - A method name mentioned inside a STRING literal (e.g. a help/error
 *     string `"call bulkLookupMetadata(x) to enrich"`) no longer contains
 *     matchable identifier characters, so it can't be mistaken for a real
 *     call expression.
 *
 * When the actual literal VALUE is needed (the real `caller` label, to
 * validate against `ALL_LML_CALLERS` or resolve a same-file `const`), map
 * the span found here back onto the ORIGINAL `content` at the same offsets —
 * see `findMatchingCloseParen` callers in `checkFile`.
 */
function blankCommentsAndStrings(content) {
  let out = '';
  let inString = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      if (c === '\\') {
        out += ' ';
        i++;
        out += content[i] === undefined ? '' : content[i] === '\n' ? '\n' : ' ';
        continue;
      }
      if (c === inString) {
        out += c;
        inString = null;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      out += c;
      continue;
    }
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      const end = nl === -1 ? content.length : nl;
      out += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (c === '/' && content[i + 1] === '*') {
      const closeIdx = content.indexOf('*/', i + 2);
      const end = closeIdx === -1 ? content.length : closeIdx + 2;
      for (let j = i; j < end; j++) out += content[j] === '\n' ? '\n' : ' ';
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Given the index of a call's opening `(`, return the index of its matching
 * closing `)`, respecting string/comment content so an unrelated `(`/`)`
 * inside a string or comment can't desync the depth count. Returns null if
 * the parens never balance (malformed input — should not happen against
 * real source). Callers slice whichever copy (raw `content` for real values,
 * `blankCommentsAndStrings` output for presence detection) they need at the
 * returned offsets — both copies share identical length/positions.
 */
function findMatchingCloseParen(content, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < content.length; i++) {
    const c = content[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl;
      continue;
    }
    if (c === '/' && content[i + 1] === '*') {
      const closeIdx = content.indexOf('*/', i + 2);
      i = closeIdx === -1 ? content.length : closeIdx + 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Escape a string for embedding in a `RegExp`. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generic bracket-depth matcher (BS#1842) — like `findMatchingCloseParen` but
 * parametrized over the open/close character pair, so it also matches `{`/`}`
 * for interface/type bodies. Respects string content so an unrelated
 * open/close char inside a string literal can't desync the depth count;
 * comments should already be blanked in the input (callers pass `blankComments`
 * output) so a stray bracket in a JSDoc example can't either.
 */
function findMatchingClose(content, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    const c = content[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * BS#1842: find every `interface`/`type` declaration in `index.ts` whose body
 * has a `caller` field (`caller:` or `caller?:`), returning the set of type
 * names. Used to resolve a function parameter that references one of these
 * types by name (e.g. `options?: CallerOption`) back to "this function is
 * caller-aware", without a full TS parser.
 */
function findCallerBearingTypeNames(codeOnly) {
  const names = new Set();
  const re = /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)[^{=]*(=\s*)?\{/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(codeOnly, openIdx, '{', '}');
    if (closeIdx === null) continue;
    const body = codeOnly.slice(openIdx + 1, closeIdx);
    if (/\bcaller\s*\??\s*:/.test(body)) names.add(m[1]);
  }
  return names;
}

/**
 * BS#1842: find every top-level `export [async ]function NAME(...)`
 * declaration, returning `Map<name, rawParamListText>`. The whole parameter
 * list (balanced on parens, comments already blanked) is returned as one
 * string so a caller-detecting regex can search it regardless of how deeply
 * an inline options object type is nested.
 */
function findExportedFunctionParams(codeOnly) {
  const map = new Map();
  const re = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(codeOnly, openIdx, '(', ')');
    if (closeIdx === null) continue;
    map.set(m[1], codeOnly.slice(openIdx + 1, closeIdx));
  }
  return map;
}

/**
 * BS#1842: derive the set of `index.ts` exported function names that accept
 * a `caller` label — by direct inline presence (`caller?:`/`caller:` in an
 * inline options object type), a `Pick<SomeType, 'caller'>`-style quoted key,
 * or a reference to a type name this file's own declarations give a `caller`
 * field (resolved via `findCallerBearingTypeNames`). This is the "should be
 * tracked by TYPE_REQUIRED_METHODS/TYPE_OPTIONAL_METHODS" ground truth the
 * drift-check compares against.
 */
function deriveCallerAwareMethodNames(indexSrc) {
  const codeOnly = blankComments(indexSrc);
  const typeNames = findCallerBearingTypeNames(codeOnly);
  const typeNameAlt = [...typeNames].map(escapeRegExp).join('|');
  const typeRefRe = typeNameAlt ? new RegExp(`\\b(?:${typeNameAlt})\\b`) : null;

  const result = new Set();
  for (const [name, paramsText] of findExportedFunctionParams(codeOnly)) {
    const hasInlineCaller = /\bcaller\s*\??\s*:/.test(paramsText);
    const hasQuotedCaller = /['"]caller['"]/.test(paramsText);
    const hasTypeRef = typeRefRe ? typeRefRe.test(paramsText) : false;
    if (hasInlineCaller || hasQuotedCaller || hasTypeRef) result.add(name);
  }
  return result;
}

/**
 * BS#1842: compare the derived caller-aware method set (from `index.ts`)
 * against this script's own hardcoded `ALL_METHODS`. Returns sorted
 * `{ missing, stale }` arrays — `missing` is a caller-aware export this
 * script doesn't scan for (the gap this issue exists to close); `stale` is a
 * tracked method `index.ts` no longer marks caller-aware (renamed/removed —
 * the entry should be dropped here too so it can't mask a real drift later).
 * Both are failures; a clean tree returns `{ missing: [], stale: [] }`.
 */
function checkMethodListDrift(indexSrc) {
  const derived = deriveCallerAwareMethodNames(indexSrc);
  const missing = [...derived].filter((n) => !ALL_METHODS.has(n)).sort();
  const stale = [...ALL_METHODS].filter((n) => !derived.has(n)).sort();
  return { missing, stale };
}

/**
 * Build a `local name -> canonical @wxyc/lml-client method name` map for one
 * file, covering plain named imports, aliased named imports
 * (`{ X as Y }`), and namespace imports (`import * as ns from
 * '@wxyc/lml-client'`, recorded under the sentinel key `'*'`). Type-only
 * import declarations (`import type { ... }`) and individually
 * `type`-prefixed specifiers inside a mixed import are skipped — they carry
 * no runtime reference, so no call expression can reach them.
 */
function buildAliasMap(content) {
  const map = new Map(); // localName -> canonicalMethodName
  let namespaceAlias = null;
  const evasions = [];

  // `\{[^{}]*\}` (not `\{[\s\S]*?\}`) so the group can't backtrack PAST an
  // unrelated import's closing brace and swallow multiple statements into
  // one match — import specifier lists never nest `{`/`}`, so excluding
  // both from the class is a safe, exact bound.
  const importRe = /import\s+(type\s+)?(\{[^{}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s*from\s*['"]@wxyc\/lml-client['"]/g;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    const isTypeOnlyDecl = Boolean(m[1]);
    const clause = m[2];
    if (isTypeOnlyDecl) continue; // whole declaration is types-only; no runtime binding.

    if (clause.startsWith('*')) {
      const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (nsMatch) {
        namespaceAlias = nsMatch[1];
        evasions.push({ kind: 'namespace-import', alias: nsMatch[1] });
      }
      continue;
    }

    // Named-import clause: split top-level entries on commas (no nesting to
    // worry about inside `{ ... }` import specifiers).
    const inner = clause.slice(1, -1);
    for (const rawEntry of inner.split(',')) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      if (/^type\s+/.test(entry)) continue; // per-specifier type-only import.
      const asMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) {
        const [, original, alias] = asMatch;
        // Named-import aliasing is resolved (not flagged) — see header doc.
        if (ALL_METHODS.has(original)) {
          map.set(alias, original);
        }
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(entry) && ALL_METHODS.has(entry)) {
        map.set(entry, entry);
      }
    }
  }

  return { map, namespaceAlias, evasions };
}

/**
 * Resolve a `caller:` value expression to a literal string, or `null` if it
 * can't be statically resolved. Handles quoted literals directly and a bare
 * identifier by searching the same file for `const IDENT = '<literal>'` —
 * the `caller: JOB_NAME` pattern every `jobs/*` cron uses.
 */
function resolveCallerValue(content, expr) {
  const quoted = expr.match(/^'([^'\\]*)'$/) || expr.match(/^"([^"\\]*)"$/);
  if (quoted) return quoted[1];

  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const constRe = new RegExp(
      `\\bconst\\s+${escapeRegExp(expr)}\\s*(?::\\s*[^=]+)?=\\s*('([^'\\\\]*)'|"([^"\\\\]*)")`
    );
    const cm = content.match(constRe);
    if (cm) return cm[2] !== undefined ? cm[2] : cm[3];
  }
  return null; // dotted/optional-chained forwarding, or genuinely unresolvable.
}

/**
 * Detect the `caller:` value expression's SPAN within a call's argument
 * list, scanning the comment-AND-string-blanked copy so a `caller:` token
 * sitting inside a comment can't register as present. Returns `{ start,
 * end }` (offsets relative to the start of `argsScanText`) or `null` if no
 * real `caller:` argument exists. The `d` (indices) flag is required to
 * recover the capture group's own span rather than the whole match's.
 */
function detectCallerExprSpan(argsScanText) {
  const re = /\bcaller\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)/d;
  const m = re.exec(argsScanText);
  if (!m) return null;
  const [start, end] = m.indices[1];
  return { start, end };
}

function checkFile(absPath, registeredCallers) {
  const rel = relative(REPO_ROOT, absPath);
  const isJobFile = rel.startsWith('jobs' + '/') || rel.startsWith('jobs\\');
  const content = readFileSync(absPath, 'utf-8');
  const codeOnly = blankComments(content);
  // Comments AND string-literal contents blanked (quotes kept, offsets
  // preserved) — the single surface used to DETECT call sites and
  // `caller:` presence, so neither a commented-out `caller:` example nor a
  // method name mentioned inside a string can produce a false result (see
  // `blankCommentsAndStrings`'s header doc).
  const scanContent = blankCommentsAndStrings(content);

  const { map: aliasMap, namespaceAlias, evasions } = buildAliasMap(codeOnly);
  const violations = [];

  // Namespace-import evasion guard: jobs/** only (apps/**/shared/** are
  // compile-time protected — see header doc). Named-import aliases are
  // RESOLVED via `aliasMap` below (not flagged) — see header doc for why.
  if (isJobFile) {
    for (const ev of evasions) {
      const line = lineOf(content, codeOnly.indexOf(`* as ${ev.alias}`));
      violations.push({
        line,
        message: `namespace import \`* as ${ev.alias}\` of @wxyc/lml-client in jobs/** — use direct named imports so caller-classification stays greppable.`,
      });
    }
  }

  // Build the set of (localName -> canonicalMethod) call targets to scan:
  // direct/aliased named imports, plus namespace-qualified access for every
  // tracked method when a namespace import is present.
  const targets = new Map(aliasMap); // localName -> canonical
  if (namespaceAlias) {
    for (const method of ALL_METHODS) {
      targets.set(`${namespaceAlias}.${method}`, method);
    }
  }
  if (targets.size === 0) return violations; // file doesn't import any tracked method.

  for (const [localName, canonical] of targets) {
    const callRe = new RegExp(`(?<![.\\w$])${escapeRegExp(localName)}\\s*\\(`, 'g');
    let cm;
    // Scan `scanContent`, not `codeOnly` — a method name mentioned inside a
    // string literal (e.g. a help/error string) has its identifier
    // characters blanked out here, so it can no longer match as a call site.
    while ((cm = callRe.exec(scanContent)) !== null) {
      const openParenIdx = cm.index + cm[0].length - 1;
      const closeParenIdx = findMatchingCloseParen(content, openParenIdx);
      const line = lineOf(content, cm.index);
      if (closeParenIdx === null) {
        violations.push({ line, message: `${localName}(...): unbalanced parens — parsing bug or malformed source.` });
        continue;
      }
      // Same span, two readings: the blanked copy to DETECT presence, the
      // original to resolve the real VALUE once presence is confirmed.
      const argsScan = scanContent.slice(openParenIdx + 1, closeParenIdx);
      const argsRaw = content.slice(openParenIdx + 1, closeParenIdx);

      const callerSpan = detectCallerExprSpan(argsScan);
      const required = TYPE_REQUIRED_METHODS.has(canonical);

      if (callerSpan === null) {
        if (required) {
          violations.push({
            line,
            message: `${localName}(...) [${canonical}]: missing \`caller\` — every call to this budget-bearing method must supply a registered caller label.`,
          });
        }
        continue;
      }

      // Map the detected span back onto the ORIGINAL argument text to read
      // the real literal/identifier — `argsScan` may hold blanked spaces in
      // place of a string's actual characters.
      const callerExpr = argsRaw.slice(callerSpan.start, callerSpan.end);
      const resolved = resolveCallerValue(content, callerExpr);
      if (resolved === null) {
        if (isJobFile) {
          violations.push({
            line,
            message: `${localName}(...) [${canonical}]: caller expression \`${callerExpr}\` is not statically resolvable in jobs/** (not a string literal or a same-file \`const\`) — register a literal label or thread one through a local const.`,
          });
        }
        // In apps/**/shared/**, an unresolved caller expression (e.g. a
        // typed `options?.caller` forward) is compiler-verified at its own
        // declaration — not a finding here.
        continue;
      }

      if (!registeredCallers.has(resolved)) {
        violations.push({
          line,
          message: `${localName}(...) [${canonical}]: caller "${resolved}" is not in ALL_LML_CALLERS — register it in shared/lml-client/src/policy.ts (BS#1826) before using it.`,
        });
      }
    }
  }

  return violations;
}

function lineOf(content, index) {
  if (index < 0) return '?';
  return content.slice(0, index).split('\n').length;
}

function main() {
  const registeredCallers = loadRegisteredCallers();

  const drift = checkMethodListDrift(loadIndexSource());
  if (drift.missing.length > 0 || drift.stale.length > 0) {
    console.error(
      "FAIL(tooling): this script's tracked method list has drifted from shared/lml-client/src/index.ts (BS#1842)."
    );
    if (drift.missing.length > 0) {
      console.error(
        `      New caller-aware export(s) not in TYPE_REQUIRED_METHODS/TYPE_OPTIONAL_METHODS: ${drift.missing.join(', ')}`
      );
    }
    if (drift.stale.length > 0) {
      console.error(
        `      Tracked method(s) index.ts no longer marks caller-aware (renamed/removed?): ${drift.stale.join(', ')}`
      );
    }
    console.error(
      '      Update TYPE_REQUIRED_METHODS / TYPE_OPTIONAL_METHODS in scripts/check-lml-caller-classification.mjs.'
    );
    process.exit(2);
  }

  const perFileViolations = [];

  for (const root of SOURCE_ROOTS) {
    for (const abs of listSourceFiles(root)) {
      const rel = relative(REPO_ROOT, abs);
      const violations = checkFile(abs, registeredCallers);
      if (violations.length > 0) {
        perFileViolations.push({ rel, violations });
      }
    }
  }

  if (perFileViolations.length > 0) {
    console.error('FAIL: BS→LML call site(s) bypass the caller-classification policy (BS#1826).');
    console.error(
      '      See shared/lml-client/src/policy.ts (ALL_LML_CALLERS) and plans/bs1826-lml-caller-classification.md.'
    );
    let total = 0;
    for (const { rel, violations } of perFileViolations) {
      for (const v of violations) {
        console.error(`      - ${rel}:${v.line}: ${v.message}`);
        total++;
      }
    }
    console.error(`      ${total} violation(s) across ${perFileViolations.length} file(s).`);
    process.exit(1);
  }

  console.log('PASS: every scanned BS→LML call site supplies a registered caller label.');
}

if (isInvokedDirectly(import.meta.url)) {
  main();
}

export {
  checkFile,
  loadRegisteredCallers,
  loadIndexSource,
  deriveCallerAwareMethodNames,
  checkMethodListDrift,
  ALL_METHODS,
  TYPE_REQUIRED_METHODS,
  TYPE_OPTIONAL_METHODS,
};
