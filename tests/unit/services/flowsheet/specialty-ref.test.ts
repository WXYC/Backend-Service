import { toSpecialtyShowRef } from '../../../../apps/backend/services/flowsheet/specialty-ref';
import type { SpecialtyShows } from '@wxyc/database';

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
  slots: [],
  active: false,
} as unknown as SpecialtyShows;

describe('toSpecialtyShowRef', () => {
  it.each([[null], [undefined]])('projects %s to null', (row) => {
    expect(toSpecialtyShowRef(row)).toBeNull();
  });

  it('projects the public fields only, retired rows included', () => {
    expect(toSpecialtyShowRef(ROW)).toEqual({
      id: 3,
      slug: 'sonic-landscapes',
      name: 'Sonic Landscapes',
      short_name: 'Landscapes',
      tagline: null,
      logs_playcuts: false,
      default_spotlight_role: 'host',
      artwork: { square_url: 's', master_url: 'm', wide_url: 'w' },
      accent_color: '#112233',
    });
  });
});
