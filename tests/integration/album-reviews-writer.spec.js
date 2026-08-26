const postgres = require('postgres');

/**
 * Integration test for the SQL contract used by the album-reviews-etl
 * writer + link pass (migration 0119, album-reviews-sheet-sync plan).
 *
 * Issues the exact statement shapes `jobs/album-reviews-etl/writer.ts` and
 * `link.ts` emit against a real PostgreSQL:
 *
 *   - ON CONFLICT arbiter on the PARTIAL unique index: the conflict target
 *     must repeat the index predicate (`WHERE source_key IS NOT NULL`) or
 *     PG cannot match the arbiter.
 *   - The IS DISTINCT FROM `setWhere` guard: an identical re-upsert is
 *     suppressed entirely (RETURNING is empty, `last_modified` untouched)
 *     — the idempotent-nightly acceptance criterion, and specifically the
 *     `submitted_at` arm binding a JS Date with an explicit `::timestamptz`
 *     cast (the BS#802 Date-through-raw-template trap: unit mocks cannot
 *     prove the driver-boundary typing, only a real PG can).
 *   - A changed field fires the UPDATE (xmax != 0) and advances
 *     `last_modified`.
 *   - Multi-review invariant: two submissions for the same album under
 *     different source_keys are DISTINCT rows (the reason this table is
 *     not ADR 0006's one-per-album `reviews`).
 *   - The link pass's guarded UPDATE (`WHERE album_id IS NULL`) never
 *     overwrites an existing link.
 *   - FK `ON DELETE SET NULL`: deleting the library row orphans the link,
 *     never the submission.
 *
 * The integration runner is babel-jest with no TypeScript support (per
 * `artist-search-alias-writer.spec.js`), so this file does NOT import the
 * writer TS; it issues the equivalent raw SQL. The TS-level shape
 * (SET_CONTENT_COLUMNS derivation, outcome mapping) is unit-tested in
 * `tests/unit/jobs/album-reviews-etl/writer.test.ts`.
 *
 * Scoped to an isolated `wxyc_test_arw_<random>` schema; dropped in
 * afterAll regardless of pass/fail.
 */

// Mirrors writer.ts: SubmissionContent keys. source_key is the conflict
// target (excluded from SET/WHERE, present in the INSERT column list).
const INSERT_COLS = [
  'artist_name',
  'album_title',
  'record_label',
  'artist_blurb',
  'review',
  'recommended_tracks',
  'buzzwords',
  'fcc_violations',
  'review_purpose',
  'reviewer_raw',
  'social_consent_raw',
  'social_consent',
  'released_within_six_months',
  'rotated',
  'submitted_at',
  'source',
  'norm_artist',
  'norm_album',
  'source_key',
];
const SET_COLS = INSERT_COLS.filter((c) => c !== 'source_key');
// writer.ts casts the JS-Date param explicitly (BS#802).
const cast = (c) => (c === 'submitted_at' ? '::timestamptz' : '');

describe('album-reviews-etl writer + link SQL contract (real DB)', () => {
  let sql;
  let schemaName;
  let upsertStatement;

  const baseContent = () => ({
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
    record_label: 'Sonamos',
    artist_blurb: 'Argentine electronic-folk auteur.',
    review: 'Hypnotic loops; a late-night staple.',
    recommended_tracks: 'la paradoja (!!!!!)',
    buzzwords: 'electronic, hypnotic',
    fcc_violations: 'None',
    review_purpose: 'Rotation',
    reviewer_raw: 'DJ Ana, 7/15/2021',
    social_consent_raw: 'Yes',
    social_consent: true,
    released_within_six_months: true,
    rotated: true,
    submitted_at: new Date('2021-07-15T18:05:33.000Z'),
    source: 'google_form',
    norm_artist: 'juana molina',
    norm_album: 'doga',
    source_key: 'form:2021-07-15T18:05:33.000Z',
  });

  const upsert = async (content) =>
    sql.unsafe(
      upsertStatement,
      INSERT_COLS.map((c) => content[c])
    );

  beforeAll(async () => {
    schemaName = `wxyc_test_arw_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);

    // Minimal `library` mirror — the FK target, plus the two extra artist
    // legs the link pass's candidate sweep reads.
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library (
        id serial PRIMARY KEY,
        artist_name text,
        album_artist text,
        alternate_artist_name text,
        album_title text
      )
    `);

    // The two SQL twins the sweep calls. Schema-local shims so the sweep
    // statement below is byte-identical to the one `link.ts` emits (which
    // schema-qualifies both), but each DELEGATES to the real migrated
    // function rather than copying its body — the
    // `bs-2117-crossreference-backfill.spec.js` precedent. A copy here would
    // keep passing after migration 0092 or 0134 changed underneath it, which
    // is precisely the drift this test exists to catch.
    await sql.unsafe(`
      CREATE FUNCTION "${schemaName}".normalize_artist_name(input text) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        AS $fn$ SELECT wxyc_schema.normalize_artist_name(input) $fn$
    `);
    await sql.unsafe(`
      CREATE FUNCTION "${schemaName}".fold_artist_name(input text) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        AS $fn$ SELECT wxyc_schema.fold_artist_name(input) $fn$
    `);

    // The 0119 table, schema-substituted (columns + FK + partial unique
    // index verbatim from the migration).
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".album_review_submissions (
        "id" serial PRIMARY KEY NOT NULL,
        "album_id" integer REFERENCES "${schemaName}".library(id) ON DELETE SET NULL,
        "artist_name" text,
        "album_title" text,
        "record_label" text,
        "artist_blurb" text,
        "review" text,
        "recommended_tracks" text,
        "buzzwords" text,
        "fcc_violations" text,
        "review_purpose" text,
        "reviewer_raw" text,
        "social_consent_raw" text,
        "social_consent" boolean,
        "released_within_six_months" boolean,
        "rotated" boolean,
        "submitted_at" timestamp with time zone,
        "source" text DEFAULT 'google_form' NOT NULL,
        "source_key" text,
        "norm_artist" text,
        "norm_album" text,
        "add_date" date DEFAULT now() NOT NULL,
        "last_modified" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await sql.unsafe(`
      CREATE UNIQUE INDEX album_review_submissions_source_key_uq
        ON "${schemaName}".album_review_submissions USING btree ("source_key")
        WHERE "source_key" IS NOT NULL
    `);

    const placeholders = INSERT_COLS.map((c, i) => `$${i + 1}${cast(c)}`).join(', ');
    const setClauses = SET_COLS.map((c) => `"${c}" = $${INSERT_COLS.indexOf(c) + 1}${cast(c)}`).join(', ');
    const whereArms = SET_COLS.map((c) => `t."${c}" IS DISTINCT FROM $${INSERT_COLS.indexOf(c) + 1}${cast(c)}`).join(
      ' OR '
    );
    upsertStatement = `
      INSERT INTO "${schemaName}".album_review_submissions AS t (${INSERT_COLS.map((c) => `"${c}"`).join(', ')})
      VALUES (${placeholders})
      ON CONFLICT ("source_key") WHERE "source_key" IS NOT NULL
      DO UPDATE SET ${setClauses}, "last_modified" = now()
      WHERE ${whereArms}
      RETURNING id, (xmax = 0) AS inserted
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
      await sql.end({ timeout: 5 });
    }
  });

  test('identical re-upsert is suppressed by setWhere: no returned row, last_modified untouched (idempotent nightly)', async () => {
    const first = await upsert(baseContent());
    expect(first).toHaveLength(1);
    expect(first[0].inserted).toBe(true);

    const [{ last_modified: before }] = await sql.unsafe(
      `SELECT last_modified FROM "${schemaName}".album_review_submissions WHERE source_key = $1`,
      [baseContent().source_key]
    );

    // The load-bearing arm: submitted_at binds a JS Date with ::timestamptz.
    // If the driver-boundary typing degraded, IS DISTINCT FROM would report
    // a difference and this would return a row + churn last_modified.
    const second = await upsert(baseContent());
    expect(second).toHaveLength(0);

    const rows = await sql.unsafe(
      `SELECT last_modified FROM "${schemaName}".album_review_submissions WHERE source_key = $1`,
      [baseContent().source_key]
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].last_modified).getTime()).toBe(new Date(before).getTime());
  });

  test('a changed field fires the UPDATE path (xmax != 0) and advances last_modified', async () => {
    const [{ last_modified: before }] = await sql.unsafe(
      `SELECT last_modified FROM "${schemaName}".album_review_submissions WHERE source_key = $1`,
      [baseContent().source_key]
    );

    const changed = { ...baseContent(), rotated: false };
    const result = await upsert(changed);
    expect(result).toHaveLength(1);
    expect(result[0].inserted).toBe(false); // ON CONFLICT UPDATE, not INSERT

    const [row] = await sql.unsafe(
      `SELECT rotated, last_modified FROM "${schemaName}".album_review_submissions WHERE source_key = $1`,
      [baseContent().source_key]
    );
    expect(row.rotated).toBe(false);
    expect(new Date(row.last_modified).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  test('two submissions for the same album under different source_keys are distinct rows (multi-review invariant)', async () => {
    const secondReview = {
      ...baseContent(),
      review: 'A different take from a different DJ.',
      reviewer_raw: 'DJ Ines, 8/2/2021',
      submitted_at: new Date('2021-08-02T14:00:00.000Z'),
      source_key: 'form:2021-08-02T14:00:00.000Z',
    };
    const result = await upsert(secondReview);
    expect(result).toHaveLength(1);
    expect(result[0].inserted).toBe(true);

    const rows = await sql.unsafe(
      `SELECT id FROM "${schemaName}".album_review_submissions WHERE norm_artist = 'juana molina' AND norm_album = 'doga'`
    );
    expect(rows.length).toBe(2);
  });

  test('the link-pass guarded UPDATE never overwrites a non-null album_id, and library deletion SET NULLs the link', async () => {
    const [lib1] = await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES ('Juana Molina', 'DOGA') RETURNING id`
    );
    const [lib2] = await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES ('Juana Molina', 'DOGA') RETURNING id`
    );
    const [submission] = await sql.unsafe(
      `SELECT id FROM "${schemaName}".album_review_submissions WHERE source_key = $1`,
      [baseContent().source_key]
    );

    // link.ts writeLink shape: guarded by id AND album_id IS NULL.
    const firstLink = await sql.unsafe(
      `UPDATE "${schemaName}".album_review_submissions SET album_id = $1 WHERE id = $2 AND album_id IS NULL RETURNING id`,
      [lib1.id, submission.id]
    );
    expect(firstLink).toHaveLength(1);

    const secondLink = await sql.unsafe(
      `UPDATE "${schemaName}".album_review_submissions SET album_id = $1 WHERE id = $2 AND album_id IS NULL RETURNING id`,
      [lib2.id, submission.id]
    );
    expect(secondLink).toHaveLength(0); // guard declined: manual/prior links always win

    const [linked] = await sql.unsafe(`SELECT album_id FROM "${schemaName}".album_review_submissions WHERE id = $1`, [
      submission.id,
    ]);
    expect(linked.album_id).toBe(lib1.id);

    // FK semantics from migration 0119: the submission survives a library
    // deletion with the link nulled, never cascades away.
    await sql.unsafe(`DELETE FROM "${schemaName}".library WHERE id = $1`, [lib1.id]);
    const [orphaned] = await sql.unsafe(`SELECT album_id FROM "${schemaName}".album_review_submissions WHERE id = $1`, [
      submission.id,
    ]);
    expect(orphaned.album_id).toBeNull();
  });

  // The widened candidate sweep (`loadCandidates` in link.ts). This spec proves
  // the SEMANTICS a real PG decides — that the two MATERIALIZED CTEs compose,
  // that `fold_artist_name` is reachable over a CTE column and inside a CASE,
  // that the `text[]` array-literal binding survives the `= ANY(...)` (the
  // BS#1068/BS#1071 splat trap), and that the `<> ''` guards hold on the legs
  // that are empty library-wide.
  //
  // It is a TRANSCRIPTION, not the emitted statement: the integration runner is
  // babel-jest with no TypeScript (see the file header), so `link.ts` cannot be
  // required here. Two deliberate deviations from what `link.ts` emits —
  // `$1`/`$2` bind params instead of inlined array literals, and a trailing
  // `ORDER BY "id"` production never asks for — so do NOT read this as
  // byte-identical. The statement TEXT is pinned separately and exactly, in
  // `tests/unit/jobs/album-reviews-etl/link.test.ts` via `renderSql`; that is
  // the test that fails if the sweep changes shape. This one would not.
  test('the candidate sweep selects via artist_name, album_artist, alternate_artist_name, and the diacritic fold', async () => {
    // Named explicitly rather than via CASCADE: album_review_submissions
    // carries an FK to library, so `TRUNCATE library CASCADE` would silently
    // take the submissions every earlier test in this file inserted with it.
    // Spelling both out keeps that destruction visible to whoever adds the
    // next test below this one.
    await sql.unsafe(`TRUNCATE "${schemaName}".library, "${schemaName}".album_review_submissions RESTART IDENTITY`);
    const [viaPrimary] = await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES ('The Stereolab', 'Dots and Loops') RETURNING id`
    );
    const [viaAlbumArtist] = await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_artist, album_title) VALUES ('Various Artists', 'Jessica Pratt', 'Quiet Signs') RETURNING id`
    );
    const [viaAlternate] = await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, alternate_artist_name, album_title) VALUES ('Thom Yorke', 'The Smile', 'Wall of Eyes') RETURNING id`
    );
    const [viaFold] = await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES ('Hermanos Gutierrez', 'Sonido Cosmico') RETURNING id`
    );
    // Never a candidate: no leg matches any probe norm.
    await sql.unsafe(`INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES ('Cat Power', 'Moon Pix')`);

    const sweep = `
      WITH normalized AS MATERIALIZED (
        SELECT
          "id",
          "album_title",
          "${schemaName}".normalize_artist_name(coalesce("artist_name", '')) AS norm_primary,
          "${schemaName}".normalize_artist_name(coalesce("album_artist", '')) AS norm_album_artist,
          "${schemaName}".normalize_artist_name(coalesce("alternate_artist_name", '')) AS norm_alternate
        FROM "${schemaName}"."library"
      ),
      folded AS MATERIALIZED (
        SELECT
          "id", "album_title", norm_primary, norm_album_artist, norm_alternate,
          CASE WHEN norm_primary <> '' THEN "${schemaName}".fold_artist_name(norm_primary) ELSE '' END AS fold_primary,
          CASE WHEN norm_album_artist <> '' THEN "${schemaName}".fold_artist_name(norm_album_artist) ELSE '' END AS fold_album_artist,
          CASE WHEN norm_alternate <> '' THEN "${schemaName}".fold_artist_name(norm_alternate) ELSE '' END AS fold_alternate
        FROM normalized
      )
      SELECT "id", "album_title", norm_primary, norm_album_artist, norm_alternate
      FROM folded
      WHERE (norm_primary <> '' AND (norm_primary = ANY($1::text[]) OR fold_primary = ANY($2::text[])))
         OR (norm_album_artist <> '' AND (norm_album_artist = ANY($1::text[]) OR fold_album_artist = ANY($2::text[])))
         OR (norm_alternate <> '' AND (norm_alternate = ANY($1::text[]) OR fold_alternate = ANY($2::text[])))
      ORDER BY "id"
    `;

    // Exactly the two literals link.ts binds: probe norms, and their folds.
    // 'hermanos gutiérrez' reaches the ASCII-filed row ONLY via the fold arm.
    const norms = '{"stereolab","jessica pratt","smile","hermanos gutiérrez"}';
    const folded = '{"stereolab","jessica pratt","smile","hermanos gutierrez"}';
    const rows = await sql.unsafe(sweep, [norms, folded]);
    // Compared as a SET: the `ORDER BY` above is a test-only convenience, so
    // removing it (to close the gap with the emitted statement) must not turn
    // this into a flake against an unordered scan.
    const byId = (a, b) => a - b;
    expect(rows.map((r) => r.id).sort(byId)).toEqual(
      [viaPrimary.id, viaAlbumArtist.id, viaAlternate.id, viaFold.id].sort(byId)
    );

    // The leading-"The " strip is the 0092 twin's job, and it ran in SQL.
    const rowById = (id) => rows.find((r) => r.id === id);
    expect(rowById(viaPrimary.id).norm_primary).toBe('stereolab');
    expect(rowById(viaAlternate.id).norm_alternate).toBe('smile');

    // The `<> ''` guards: an empty probe norm must not drag in the rows whose
    // album_artist / alternate_artist_name legs are empty (all of them, in
    // production). Without the guards this returns the whole table.
    const empty = await sql.unsafe(sweep, ['{""}', '{""}']);
    expect(empty).toHaveLength(0);
  });
});
