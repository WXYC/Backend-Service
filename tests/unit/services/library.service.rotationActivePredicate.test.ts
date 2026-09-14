/**
 * BS#2479: the canonical active-rotation predicate (`kill_date IS NULL OR
 * kill_date > CURRENT_DATE`) must be spelled ONCE, in `rotationActiveSql()`,
 * and every other rotation read must consume that fragment rather than
 * retyping the predicate. Before this issue, four call sites in
 * library.service.ts hand-rolled the same predicate independently — a
 * silent drift risk, since a future edit to one spelling would not touch
 * the others.
 *
 * Pure file-reading guard, in the style of `schema.rotation-cards.test.ts`:
 * it greps the compiled source text rather than exercising the query
 * builder, because the thing under test is "how many places spell this
 * predicate," which a mocked `db.execute` call can't observe.
 */

import * as fs from 'fs';
import * as path from 'path';

const sourcePath = path.resolve(__dirname, '../../../apps/backend/services/library.service.ts');
const source = fs.readFileSync(sourcePath, 'utf-8');

// Matches the predicate's two interpolated orderings —
// `${rotation.kill_date} IS NULL OR ${rotation.kill_date} > CURRENT_DATE`
// and its `> CURRENT_DATE OR ... IS NULL` mirror — as they appear inside a
// `sql` template, not as prose in a comment (which never interpolates
// `${rotation.kill_date}`).
const HAND_WRITTEN_PREDICATE =
  /\$\{rotation\.kill_date\}\s*(?:IS NULL\s*OR\s*\$\{rotation\.kill_date\}\s*>\s*CURRENT_DATE|>\s*CURRENT_DATE\s*OR\s*\$\{rotation\.kill_date\}\s*IS NULL)/g;

describe('library.service.ts: canonical active-rotation predicate is spelled once (BS#2479)', () => {
  it('the OR-predicate over rotation.kill_date and CURRENT_DATE appears exactly once — inside rotationActiveSql()', () => {
    const matches = source.match(HAND_WRITTEN_PREDICATE) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('the one surviving spelling is the rotationActiveSql() definition', () => {
    const match = source.match(HAND_WRITTEN_PREDICATE) ?? [];
    expect(match).toHaveLength(1);
    const index = source.indexOf(match[0]);
    const line = source.slice(0, index).split('\n').length;
    const definitionLine = source.split('\n').findIndex((l) => l.includes('const rotationActiveSql = ()'));
    expect(definitionLine).toBeGreaterThan(-1);
    expect(line).toBe(definitionLine + 1);
  });

  it('every consumer of the active predicate calls rotationActiveSql() rather than retyping it', () => {
    const consumerCallCount = (source.match(/rotationActiveSql\(\)/g) ?? []).length;
    // The definition's own call-signature `() =>` is not a call site, so
    // this counts only invocations. Card paths that must call it:
    // listRotationCardsFromDB's JOIN + subquery, deleteRotationCardFromDB's
    // guard, getRotationFromDB's status=active facet, the raw JOIN mirror
    // (LIBRARY_VIEW_JOINS_RAW), libraryViewQuery's leftJoin, and the LML
    // legacy-id bulk lookup's leftJoin — at least six call sites.
    expect(consumerCallCount).toBeGreaterThanOrEqual(6);
  });
});
