describe('fetchLmlIdentities', () => {
  // Re-imported per test so the module-scoped client cache is fresh for each
  // case. Also lets us toggle DATABASE_URL_DISCOGS on/off without leaking.
  const originalEnv = process.env.DATABASE_URL_DISCOGS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DATABASE_URL_DISCOGS;
    else process.env.DATABASE_URL_DISCOGS = originalEnv;
    jest.resetModules();
  });

  test('throws a clear error when DATABASE_URL_DISCOGS is not set', async () => {
    delete process.env.DATABASE_URL_DISCOGS;
    const { fetchLmlIdentities } = await import('../../../../jobs/artist-identity-etl/fetch-lml');
    await expect(fetchLmlIdentities(null)).rejects.toThrow(/DATABASE_URL_DISCOGS/);
  });
});
