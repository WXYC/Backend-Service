/**
 * Refresh the vendored snapshot of triangle-shows' `EventResponse` OpenAPI
 * component (`tests/fixtures/triangle-shows/event-response.schema.json`).
 * Run by hand after any change to the fork's EventResponse; never from CI or
 * a test (the contract test reads the committed file only). Run from the repo root.
 *
 *   npx tsx scripts/refresh-triangle-shows-contract.ts https://triangle-shows-production.up.railway.app
 *
 * The base URL falls back to TRIANGLE_SHOWS_URL. Only `properties` and
 * `required` are kept, with sorted keys, so the diff shows contract changes only.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SNAPSHOT = resolve(process.cwd(), 'tests/fixtures/triangle-shows/event-response.schema.json');

const baseUrl = (process.argv[2] || process.env.TRIANGLE_SHOWS_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('usage: tsx scripts/refresh-triangle-shows-contract.ts <base-url> (or set TRIANGLE_SHOWS_URL)');
  process.exit(1);
}

const sortKeys = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

async function main(): Promise<void> {
  const res = await fetch(`${baseUrl}/openapi.json`);
  if (!res.ok) {
    console.error(`GET ${baseUrl}/openapi.json failed: ${res.status}`);
    process.exit(1);
  }
  const component = ((await res.json()) as { components?: { schemas?: Record<string, any> } }).components?.schemas
    ?.EventResponse;
  if (!component?.properties) {
    console.error('openapi.json has no components.schemas.EventResponse.properties');
    process.exit(1);
  }

  const snapshot = { properties: sortKeys(component.properties), required: [...(component.required ?? [])].sort() };
  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote ${Object.keys(snapshot.properties).length} properties, ${snapshot.required.length} required`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
