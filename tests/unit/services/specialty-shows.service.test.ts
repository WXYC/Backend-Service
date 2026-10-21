import { readFileSync } from 'node:fs';
import type { SpecialtyShows } from '@wxyc/database';
import { toSpecialtyShowRef } from '../../../apps/backend/services/flowsheet/specialty-ref';
import { toSpecialtyShow } from '../../../apps/backend/services/specialty-shows.service';

const ROW = {
  id: 3,
  specialty_name: 'Sonic Landscapes',
  description: 'internal',
  add_date: '2026-01-01',
  last_modified: new Date('2026-01-01T00:00:00Z'),
  slug: 'sonic-landscapes',
  short_name: 'Landscapes',
  tagline: null,
  logs_playcuts: false,
  default_spotlight_role: 'host',
  artwork: { square_url: 's', master_url: 'm', wide_url: 'w' },
  accent_color: '#112233',
  slots: [{ day: 1 }],
  active: false,
} as unknown as SpecialtyShows;

describe('toSpecialtyShow', () => {
  it('is the ref plus description, slots and active', () => {
    expect(toSpecialtyShow(ROW)).toEqual({
      ...toSpecialtyShowRef(ROW),
      description: 'internal',
      slots: [{ day: 1 }],
      active: false,
    });
  });
});

describe('specialty-ref module graph', () => {
  it('does not import the services that import it (no cycle)', () => {
    const source = readFileSync(require.resolve('../../../apps/backend/services/flowsheet/specialty-ref'), 'utf8');
    expect(source).not.toMatch(/from '\.\.?\/(flowsheet|specialty-shows)\.service/);
  });
});
