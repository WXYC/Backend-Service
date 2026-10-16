/**
 * Pins `apps/backend/app.yaml`'s `RotationBin` component to `ROTATION_BINS`
 * (BS#2196). app.yaml is Swagger-UI only, so nothing regenerates it from the
 * TypeScript SSOT; before this guard the enum was inlined at every site and
 * drifted twice in one wave (the stale `'N'`, BS#2173). Same shape as the
 * `unrecoverable` table guard in `app-yaml-unrecoverable-dependents.test.ts`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { ROTATION_BINS } from '../../../../shared/database/src/rotation-bin';

const doc = parseYaml(readFileSync(join(__dirname, '../../../../apps/backend/app.yaml'), 'utf8'));

/** Every `rotation_bin` property schema anywhere in the document. */
const collectRotationBinProperties = (node: unknown, found: unknown[] = []): unknown[] => {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'rotation_bin') {
        found.push(value);
      }
      collectRotationBinProperties(value, found);
    }
  }
  return found;
};

describe('app.yaml RotationBin', () => {
  it('enumerates exactly ROTATION_BINS', () => {
    expect(doc.components.schemas.RotationBin.enum).toEqual([...ROTATION_BINS]);
  });

  it('is the only rotation_bin enum: no property inlines its own', () => {
    const inlined = collectRotationBinProperties(doc).filter((p) => p && typeof p === 'object' && 'enum' in p);
    expect(inlined).toEqual([]);
  });
});
