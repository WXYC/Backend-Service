/**
 * Pins `apps/backend/app.yaml`'s hand-restated `unrecoverable` table lists
 * (BS#2618) to the exported constants they restate (BS#2624). The sibling
 * copy in `wxyc-shared/api.yaml` already carries this guard (wxyc-shared#511)
 * -- this is the same shape for the copy that had none.
 *
 * First test in this repo to load `app.yaml` with a real YAML loader rather
 * than grepping for a prose mention; it parses cleanly under `strict: true`
 * as of BS#2624, so there was nothing to fix here. Treat this file as the
 * pattern for the next document-pinning test in this class (see BS#2454 /
 * BS#2196), not a one-off.
 *
 * Assertions are membership + paragraph-scoping only, never whole sentences
 * -- a wording improvement to either description must not fail this test.
 * Table names are backtick-anchored (`` `library_identity` ``, not the bare
 * substring) so a check can't be satisfied by `library_identity_source`
 * sitting in the same paragraph -- the trap wxyc-shared#511's own comment
 * records.
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
 * Every table either constant names today, hardcoded rather than derived
 * from the constants themselves -- a bidirectional check needs a candidate
 * list that doesn't shrink when the thing under test (the constant) is the
 * one that gets tampered with. A table dropped from a constant without its
 * document paragraph also losing it must still be checked against, or
 * "removed from a constant" tamper-verifies as a silent no-op instead of a
 * failure.
 */
const UNRECOVERABLE_TABLE_UNIVERSE = [
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

function paragraphs(description: string): string[] {
  return description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** The paragraph that opens by naming the given entity_kind's batch. */
function findKindParagraph(description: string, kind: 'library' | 'artist'): string {
  const opener = kind === 'library' ? /^For a `library` batch/ : /^(For an `artist` batch|An `artist` batch)/;
  const match = paragraphs(description).find((paragraph) => opener.test(paragraph));
  if (!match) throw new Error(`no \`${kind}\` batch paragraph found`);
  return match;
}

function mentionsTable(paragraph: string, table: string): boolean {
  return new RegExp('`' + table + '`').test(paragraph);
}

describe('apps/backend/app.yaml unrecoverable dependent lists', () => {
  const doc = parseYaml(readFileSync(APP_YAML_PATH, 'utf8'), { strict: true });

  const listDescription: string = doc.paths['/library/deleted'].get.description;
  const restoreDescription: string = doc.paths['/library/deleted/{batchId}/restore'].post.description;

  describe.each([
    ['GET /library/deleted', () => listDescription],
    ['POST /library/deleted/{batchId}/restore', () => restoreDescription],
  ])('%s', (_name, getDescription) => {
    it.each(UNRECOVERABLE_TABLE_UNIVERSE)('scopes `%s` to exactly the paragraph its constant names it in', (table) => {
      const libraryParagraph = findKindParagraph(getDescription(), 'library');
      const artistParagraph = findKindParagraph(getDescription(), 'artist');
      expect(mentionsTable(libraryParagraph, table)).toBe(
        (UNRECOVERABLE_DEPENDENTS as readonly string[]).includes(table)
      );
      expect(mentionsTable(artistParagraph, table)).toBe(
        (UNRECOVERABLE_ARTIST_DEPENDENTS as readonly string[]).includes(table)
      );
    });
  });
});
