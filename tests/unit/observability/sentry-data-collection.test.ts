/**
 * Sentry's data collection is pinned to the Sentry 10 posture (BS#3004).
 *
 * Sentry 11 changed the defaults with no option set: it now attaches end-user
 * IPs, `X-Forwarded-For` / `X-Real-IP` headers, full query strings and
 * incoming request bodies, where 10.75.0 sent none of them. `sendDefaultPii`
 * no longer exists, so `dataCollection` is the only lever, and any field it
 * omits falls back to the permissive default. The behavioral test therefore
 * resolves the constant through the real SDK and compares every field.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as Sentry from '@sentry/node';
import { SENTRY_DATA_COLLECTION } from '@wxyc/observability';

// What 10.75.0 resolved to with neither `dataCollection` nor `sendDefaultPii`
// set (`defaultPiiToCollectionOptions(undefined)`), plus `queues: false`, which
// has no v10 counterpart.
const PII_HEADER_SNIPPETS = ['forwarded', '-ip', 'remote-', 'via', '-user'];
const SENTRY_10_POSTURE = {
  userInfo: false,
  cookies: { deny: PII_HEADER_SNIPPETS },
  httpHeaders: { request: { deny: PII_HEADER_SNIPPETS }, response: { deny: PII_HEADER_SNIPPETS } },
  urlQueryParams: { deny: PII_HEADER_SNIPPETS },
  httpBodies: [],
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: true, variables: true },
  stackFrameVariables: true,
  frameContextLines: 7,
};

describe('SENTRY_DATA_COLLECTION', () => {
  afterEach(async () => {
    await Sentry.close();
  });

  it('resolves, field for field, to the Sentry 10 data-collection posture', () => {
    Sentry.init({ dataCollection: SENTRY_DATA_COLLECTION, defaultIntegrations: false });
    expect(Sentry.getClient()?.getDataCollectionOptions()).toEqual(SENTRY_10_POSTURE);
  });
});

describe('app preloads', () => {
  it.each([
    ['backend', '../../../apps/backend/instrument.ts'],
    ['auth', '../../../apps/auth/instrument.ts'],
    ['enrichment-worker', '../../../apps/enrichment-worker/instrument.ts'],
  ])('%s passes SENTRY_DATA_COLLECTION to Sentry.init', (_app, relPath) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(source).toMatch(/Sentry\.init\(\{[\s\S]*\bdataCollection: SENTRY_DATA_COLLECTION,[\s\S]*\}\);/);
  });
});
