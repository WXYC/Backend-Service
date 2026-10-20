import type { SpecialtyShowArtwork, SpecialtyShowSlot } from '../../../shared/database/src/schema';

// Pins the jsonb shapes to the api.yaml SpecialtyShowArtwork / SpecialtyShowSlot contract. These are compile-time
// checks (npm run typecheck:tests); the runtime assertions only keep jest from reporting an empty suite.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('specialty show jsonb types', () => {
  it('allows null master_url and wide_url on artwork', () => {
    const artwork: SpecialtyShowArtwork = {
      square_url: 'https://example.com/sq.jpg',
      master_url: null,
      wide_url: null,
    };
    const shape: Equal<
      SpecialtyShowArtwork,
      { square_url: string; master_url: string | null; wide_url: string | null }
    > = true;
    expect(artwork.square_url).toBeDefined();
    expect(shape).toBe(true);
  });

  it('limits slot cadence to weekly | some_weeks | last_of_month', () => {
    const cadence: Equal<SpecialtyShowSlot['cadence'], 'weekly' | 'some_weeks' | 'last_of_month'> = true;
    expect(cadence).toBe(true);
  });
});
