/**
 * What the album-reviews import prints for a failure (BS#3132). A postgres.js error carries the server's `detail`
 * (a constraint violation's `Failing row contains (...)`), `where`, and, for a data exception, a `message` that quotes
 * the offending value; each can hold a reviewer's name or a review's text (docs/pii.md: never in logs). The terminal
 * line keeps the SQLSTATE and the names of what it was raised against, nothing a row's values ride in.
 */

import postgres from 'postgres';
import { describeError } from '../../../../jobs/album-reviews-import/import';

const REVIEWER = 'Test Reviewer';
const REVIEW_TEXT = 'A form review that quotes a private aside.';

const pgError = (fields: Record<string, unknown>) =>
  new postgres.PostgresError({ severity: 'ERROR', message: 'a server message', ...fields });

describe('describeError', () => {
  it('keeps the SQLSTATE and the constraint, and drops the failing row', () => {
    const error = pgError({
      code: '23514',
      message: 'new row for relation "reviews" violates check constraint "reviews_target_ck"',
      detail: `Failing row contains (1, null, null, ${REVIEW_TEXT}, ${REVIEWER}).`,
      where: `SQL statement "INSERT ... ${REVIEWER}"`,
      table_name: 'reviews',
      constraint_name: 'reviews_target_ck',
    });

    const line = describeError(error);

    expect(line).toContain('23514');
    expect(line).toContain('reviews_target_ck');
    expect(line).not.toContain(REVIEWER);
    expect(line).not.toContain(REVIEW_TEXT);
    expect(line).not.toContain('Failing row');
  });

  it('drops the message of a data exception, which quotes the offending value', () => {
    const error = pgError({
      code: '22P02',
      message: `invalid input syntax for type integer: "${REVIEWER}"`,
      column_name: 'album_id',
    });

    const line = describeError(error);

    expect(line).toContain('22P02');
    expect(line).toContain('album_id');
    expect(line).not.toContain(REVIEWER);
  });

  it('keeps the message of any other database error, which names no value', () => {
    expect(describeError(pgError({ code: '42501', message: 'permission denied for table reviews' }))).toContain(
      'permission denied for table reviews'
    );
  });

  it('keeps the message of an error that is not from the database', () => {
    expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(
      'Error: connect ECONNREFUSED 127.0.0.1:5432'
    );
  });

  it('describes a thrown value that is not an Error without printing it', () => {
    expect(describeError(REVIEWER)).not.toContain(REVIEWER);
  });
});
