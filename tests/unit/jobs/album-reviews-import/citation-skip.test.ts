/**
 * Which citing intake items make the album-reviews import skip a form row (BS#3164, rule in ADR 0011): an item that is
 * not yet filed, or one filed as the row's own release. The decision is one SQL condition inside the import's scan
 * (`tests/integration/album-reviews-import.spec.js` runs it against Postgres, a row kind per case); this pins that the
 * condition reads the one list of filed states, so the job cannot drift from the service.
 */

import { FILED_STATES } from '@wxyc/database';
import { runImport } from '../../../../jobs/album-reviews-import/import';
import { FILED_STATES as SERVICE_FILED_STATES } from '../../../../apps/backend/services/intake.service';

interface Captured {
  text: string;
  values: unknown[];
}

/** A postgres.js stand-in that records each template query and answers every query with no rows. */
const scan = async () => {
  const queries: Captured[] = [];
  const tx = (first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first) && 'raw' in first) {
      queries.push({ text: (first as unknown as string[]).join('?'), values });
      return Promise.resolve([]);
    }
    return { helper: first };
  };
  const sql = { begin: async (_mode: string, run: (t: typeof tx) => Promise<void>) => run(tx) };
  await runImport(sql as never, { schema: 'wxyc_schema', apply: false, log: () => undefined });
  return queries.find((q) => q.text.includes('cited_submission_id'));
};

describe('the import’s citation skip', () => {
  it('shares one list of filed states with the intake service', () => {
    expect(FILED_STATES).toEqual(['filed', 'finalized']);
    expect(SERVICE_FILED_STATES).toBe(FILED_STATES);
  });

  it('counts a citing item only when it is unfiled or filed as the row’s own release', async () => {
    const { text, values } = await scan();
    expect(text.replace(/\s+/g, ' ')).toContain(
      '? i WHERE i.cited_submission_id = s.id AND (i.state NOT IN ? OR i.album_id = s.album_id)) AS cited'
    );
    expect(values).toContainEqual({ helper: FILED_STATES });
  });
});
