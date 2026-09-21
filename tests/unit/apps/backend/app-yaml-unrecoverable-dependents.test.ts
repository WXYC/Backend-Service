/**
 * Pins `apps/backend/app.yaml`'s hand-restated `unrecoverable` table lists
 * (BS#2618) to the exported constants they restate (BS#2624). The sibling
 * copy in `wxyc-shared/api.yaml` already carries this guard (wxyc-shared#511)
 * -- this is the same shape for the copy that had none.
 *
 * First test in this repo to load `app.yaml` with a real YAML loader rather
 * than grepping for a prose mention; `yaml` is a declared root devDependency
 * as of BS#2624 rather than one inherited by hoisting from
 * `apps/backend/package.json`. Treat this file as the pattern for the next
 * document-pinning test in this class (see BS#2454 / BS#2196), not a one-off.
 *
 * Three separate things this spec depends on, only the first of which is
 * wording-independent:
 *
 * 1. The TABLE LISTS. Assertions are membership + paragraph-scoping only,
 *    never whole sentences -- a wording improvement inside either paragraph
 *    must not fail this test. Table names are backtick-anchored
 *    (`` `library_identity` ``, not the bare substring) so a check can't be
 *    satisfied by `library_identity_source` sitting in the same paragraph --
 *    the trap wxyc-shared#511's own comment records.
 * 2. The PARAGRAPH OPENERS, which are NOT wording-independent.
 *    `findKindParagraph` matches literal sentence openers, and the two
 *    documents already open their artist paragraph two different ways ("For
 *    an `artist` batch" vs "An `artist` batch"), so a third phrasing is
 *    expected: each paragraph must keep opening by naming its `entity_kind`,
 *    and a new phrasing means adding an alternative to `kindOpener` below.
 *    Deliberately a code change rather than a looser match -- several other
 *    paragraphs in both descriptions mention both kinds, so a vaguer marker
 *    would scope the membership assertions to the wrong text and still pass.
 * 3. The PARAGRAPH BREAKS, which are a formatting convention app.yaml
 *    records nowhere. Both descriptions are folded (`>`) block scalars, and
 *    YAML folding turns a single blank line into `\n` but only a DOUBLE
 *    blank line into `\n\n`. `splitParagraphs` splits on a blank line in the
 *    PARSED string, so a reflow collapsing app.yaml's double blank lines to
 *    single ones yields one paragraph and makes every scoping assertion
 *    vacuous. Hence the paragraph count and per-paragraph openings in the
 *    not-found message -- that failure has to name what happened.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  UNRECOVERABLE_ARTIST_DEPENDENTS,
  UNRECOVERABLE_DEPENDENTS,
} from '../../../../shared/database/src/catalog-delete-envelope';

const APP_YAML_PATH = join(__dirname, '../../../../apps/backend/app.yaml');

/**
 * Every table either constant named when this guard was written, hardcoded
 * rather than derived -- a bidirectional check needs a candidate list that
 * doesn't shrink when the thing under test (the constant) is the one that
 * gets tampered with. A table dropped from a constant without its document
 * paragraph also losing it must still be checked against, or "removed from a
 * constant" tamper-verifies as a silent no-op instead of a failure. Frozen on
 * purpose: nothing should be added here when a constant grows.
 */
const HISTORICAL_UNRECOVERABLE_TABLES = [
  'album_metadata',
  'library_identity',
  'library_identity_source',
  'uncovered_release_search_markers',
  'album_review_submissions',
  'artist_search_alias',
  'artist_similar_artists',
  'artist_station_plays',
  'concerts',
  'concert_performers',
];

/**
 * The frozen list UNION what the constants name today, so the check fails in
 * both directions of drift. A table REMOVED from a constant stays in the
 * universe via the frozen half and goes red on the paragraph that still names
 * it; a table ADDED to a constant enters the universe via the live half and
 * goes red until both paragraphs name it.
 */
const UNRECOVERABLE_TABLE_UNIVERSE = [
  ...new Set([...HISTORICAL_UNRECOVERABLE_TABLES, ...UNRECOVERABLE_DEPENDENTS, ...UNRECOVERABLE_ARTIST_DEPENDENTS]),
];

const doc = parseYaml(readFileSync(APP_YAML_PATH, 'utf8')) as {
  paths?: {
    '/library/deleted'?: { get?: { description?: unknown } };
    '/library/deleted/{batchId}/restore'?: { post?: { description?: unknown } };
  };
};

/**
 * Reads one operation's `description`, naming the exact path expression when
 * it isn't there. A renamed path key or method otherwise throws a bare
 * `TypeError` off `undefined` that names neither the path nor the file.
 */
function requireDescription(operation: { description?: unknown } | undefined, expression: string): string {
  const description = operation?.description;
  if (typeof description !== 'string') {
    throw new Error(`${APP_YAML_PATH}: ${expression} is missing or not a string (got ${typeof description})`);
  }
  return description;
}

function splitParagraphs(description: string): string[] {
  return description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** See point 2 of this file's docstring before loosening either pattern. */
function kindOpener(kind: 'library' | 'artist'): RegExp {
  return kind === 'library' ? /^For a `library` batch/ : /^(For an `artist` batch|An `artist` batch)/;
}

/** The paragraph that opens by naming the given entity_kind's batch. */
function findKindParagraph(label: string, description: string, kind: 'library' | 'artist'): string {
  const paragraphs = splitParagraphs(description);
  const match = paragraphs.find((paragraph) => kindOpener(kind).test(paragraph));
  if (!match) {
    const openings = paragraphs.map((paragraph, index) => `  [${index}] ${paragraph.slice(0, 60)}`).join('\n');
    throw new Error(
      `${label}: no \`${kind}\` batch paragraph matched ${String(kindOpener(kind))}. ` +
        `Split into ${paragraphs.length} paragraph(s) -- a count of 1 means app.yaml's folded ` +
        `scalar lost the DOUBLE blank lines that separate them:\n${openings}`
    );
  }
  return match;
}

function mentionsTable(paragraph: string, table: string): boolean {
  return new RegExp('`' + table + '`').test(paragraph);
}

describe('apps/backend/app.yaml unrecoverable dependent lists', () => {
  describe.each([
    [
      'GET /library/deleted',
      requireDescription(doc.paths?.['/library/deleted']?.get, "paths['/library/deleted'].get.description"),
    ],
    [
      'POST /library/deleted/{batchId}/restore',
      requireDescription(
        doc.paths?.['/library/deleted/{batchId}/restore']?.post,
        "paths['/library/deleted/{batchId}/restore'].post.description"
      ),
    ],
  ])('%s', (label, description) => {
    const libraryParagraph = findKindParagraph(label, description, 'library');
    const artistParagraph = findKindParagraph(label, description, 'artist');

    it.each(UNRECOVERABLE_TABLE_UNIVERSE)('scopes `%s` to exactly the paragraph its constant names it in', (table) => {
      expect(mentionsTable(libraryParagraph, table)).toBe(
        (UNRECOVERABLE_DEPENDENTS as readonly string[]).includes(table)
      );
      expect(mentionsTable(artistParagraph, table)).toBe(
        (UNRECOVERABLE_ARTIST_DEPENDENTS as readonly string[]).includes(table)
      );
    });
  });
});
