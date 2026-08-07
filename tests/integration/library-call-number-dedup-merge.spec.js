/**
 * Integration tests for the REAL shipped functions of
 * `jobs/library-call-number-dedup`, against a real Postgres.
 *
 * The headline invariant is an ORDERING one that no unit test can prove,
 * because it only exists in the database's own constraint behaviour: every FK
 * referencing `library.id` must be repointed to the survivor BEFORE the losing
 * row is deleted. Five of the reference sites cascade and two null the
 * reference out, so a merge that deleted first would silently destroy
 * rotation history, album metadata, and reviews — no error, no exception, just
 * missing rows. These tests seed exactly that shape and assert the data
 * survives the merge attached to the survivor.
 *
 * Also covered, because they are the branches that would fail loudly in
 * production and quietly in review:
 *   (a) `album_metadata.album_id` is a PRIMARY KEY — when both the survivor and
 *       the loser carry a row, a naive repoint is a PK violation. The loser's
 *       row must be dropped instead (the survivor already has the equivalent).
 *   (b) `compilation_track_artist` has a 3-column unique key, the same
 *       collision case one level wider.
 *   (c) `library_identity` declares no cascade at all, so it would BLOCK the
 *       delete if it were ever missed — the one site that fails safe.
 *   (d) the slot key itself: same artist and number under a different GENRE is
 *       a different shelf and must not merge, while a volume letter differing
 *       only by CASE is the same slot and must.
 * Plus an idempotency re-scan (a merged slot drops out of findCollisionSlots).
 *
 * The merge functions use the `@wxyc/database` `db` singleton (its own pool,
 * DB_* env); this spec seeds and asserts via `getTestDb()` (a separate pool on
 * the same DB). All writes commit, so the two pools see each other's rows.
 * When `merge.ts` changes, rebuild before running
 * (`npm run build --workspace=@wxyc/library-call-number-dedup`); CI's Build
 * step produces `dist/merge.cjs` before the integration tier runs.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (written for the
// ts-jest unit tier) is AUTOMATICALLY applied to every `drizzle-orm` require.
// Our compiled `dist/merge.cjs` requires the REAL drizzle-orm, so unmock it.
// Hoisted above the requires below by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const merge = require(path.join(__dirname, '..', '..', 'jobs', 'library-call-number-dedup', 'dist', 'merge.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ID = 11; // exists in the integration fixture
const OTHER_GENRE_ID = 7;
const FORMAT_ID = 1;

describe('library-call-number-dedup — REAL merge functions (real PG)', () => {
  let sql;
  let artistId;
  const libraryIds = [];

  /** Seed one library row on a given shelf slot and remember it for cleanup. */
  const seedAlbum = async ({ title, codeNumber, vol = null, genreId = GENRE_ID }) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (artist_id, genre_id, format_id, album_title, code_number, code_volume_letters)
      VALUES (${artistId}, ${genreId}, ${FORMAT_ID}, ${title}, ${codeNumber}, ${vol})
      RETURNING id
    `;
    libraryIds.push(row.id);
    return row.id;
  };

  const slotFor = async (codeNumber, genreId = GENRE_ID) => {
    const slots = await merge.findCollisionSlots();
    return slots.find((s) => s.artist_id === artistId && s.genre_id === genreId && s.code_number === codeNumber);
  };

  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    const [a] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES ('Chuquimamani-Condori', 'Chuquimamani-Condori', 'CH')
      RETURNING id
    `;
    artistId = a.id;
  });

  // Teardown has to observe the SAME ordering the job does: `bins`,
  // `library_identity`, and `library_identity_source` declare no cascade, so
  // Postgres refuses to delete a `library` row they still reference. Deleting
  // the parent first raises `library_identity_library_id_library_id_fk` — which
  // is exactly the loud failure that makes those three the safe sites.
  //
  // The reset is in a `finally` so a teardown that does throw takes down only
  // its own test: without it, `libraryIds` keeps the already-attempted ids and
  // every subsequent test re-runs the same failing delete and inherits the
  // error, turning one broken test into a broken file.
  afterEach(async () => {
    try {
      if (libraryIds.length > 0) {
        await sql`DELETE FROM ${sql(SCHEMA)}.library_identity_source WHERE library_id = ANY(${libraryIds})`;
        await sql`DELETE FROM ${sql(SCHEMA)}.library_identity WHERE library_id = ANY(${libraryIds})`;
        await sql`DELETE FROM ${sql(SCHEMA)}.bins WHERE album_id = ANY(${libraryIds})`;
        await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
      }
      if (artistId) await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
    } finally {
      libraryIds.length = 0;
      artistId = null;
    }
  });

  describe('repoint-before-delete (the cascade invariant)', () => {
    it('preserves the loser’s album_metadata by repointing it, never cascading it away', async () => {
      const keep = await seedAlbum({ title: 'DJ E', codeNumber: 4 });
      const lose = await seedAlbum({ title: 'DJ E', codeNumber: 4 });
      await sql`
        INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, discogs_url)
        VALUES (${lose}, 'https://www.discogs.com/release/loser')
      `;

      const slot = await slotFor(4);
      const plan = (await merge.planSlots([slot]))[0];
      expect(plan.kind).toBe('merge');
      await merge.mergeSlot(plan);

      const rows = await sql`
        SELECT album_id, discogs_url FROM ${sql(SCHEMA)}.album_metadata
         WHERE album_id IN (${keep}, ${lose})
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].album_id).toBe(plan.survivorId);
      expect(rows[0].discogs_url).toBe('https://www.discogs.com/release/loser');
    });

    it('preserves compilation tracks attached to the losing row', async () => {
      await seedAlbum({ title: 'Edits', codeNumber: 5 });
      const lose = await seedAlbum({ title: 'Edits', codeNumber: 5 });
      await sql`
        INSERT INTO ${sql(SCHEMA)}.compilation_track_artist (library_id, artist_name, track_title)
        VALUES (${lose}, 'Chuquimamani-Condori', 'Call Your Name')
      `;

      const plan = (await merge.planSlots([await slotFor(5)]))[0];
      await merge.mergeSlot(plan);

      const rows = await sql`
        SELECT library_id, track_title FROM ${sql(SCHEMA)}.compilation_track_artist
         WHERE library_id = ${plan.survivorId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].track_title).toBe('Call Your Name');
    });
  });

  describe('unique-key collisions', () => {
    it('drops the loser’s album_metadata when the survivor already has one (PK collision)', async () => {
      const a = await seedAlbum({ title: 'Sisa Pacha', codeNumber: 6 });
      const b = await seedAlbum({ title: 'Sisa Pacha', codeNumber: 6 });
      for (const [id, url] of [
        [a, 'https://www.discogs.com/release/a'],
        [b, 'https://www.discogs.com/release/b'],
      ]) {
        await sql`INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, discogs_url) VALUES (${id}, ${url})`;
      }

      const plan = (await merge.planSlots([await slotFor(6)]))[0];
      await expect(merge.mergeSlot(plan)).resolves.toBeDefined();

      const rows = await sql`
        SELECT album_id FROM ${sql(SCHEMA)}.album_metadata WHERE album_id IN (${a}, ${b})
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].album_id).toBe(plan.survivorId);
    });

    it('drops a colliding compilation track on the 3-column unique key', async () => {
      const a = await seedAlbum({ title: 'Nueva Era', codeNumber: 7 });
      const b = await seedAlbum({ title: 'Nueva Era', codeNumber: 7 });
      for (const id of [a, b]) {
        await sql`
          INSERT INTO ${sql(SCHEMA)}.compilation_track_artist (library_id, artist_name, track_title)
          VALUES (${id}, 'Chuquimamani-Condori', 'Sonido Wapaneko')
        `;
      }

      const plan = (await merge.planSlots([await slotFor(7)]))[0];
      await expect(merge.mergeSlot(plan)).resolves.toBeDefined();

      const rows = await sql`
        SELECT library_id FROM ${sql(SCHEMA)}.compilation_track_artist WHERE library_id IN (${a}, ${b})
      `;
      expect(rows).toHaveLength(1);
    });

    it('drops the loser’s review rather than violating reviews_album_id_unique', async () => {
      const a = await seedAlbum({ title: 'Sueño Salvaje', codeNumber: 12 });
      const b = await seedAlbum({ title: 'Sueño Salvaje', codeNumber: 12 });
      for (const id of [a, b]) {
        await sql`INSERT INTO ${sql(SCHEMA)}.reviews (album_id, review) VALUES (${id}, 'a review')`;
      }

      const plan = (await merge.planSlots([await slotFor(12)]))[0];
      // `reviews.album_id` carries a plain UNIQUE, so a repoint into a survivor
      // that already has a review raises and aborts the entire run.
      await expect(merge.mergeSlot(plan)).resolves.toBeDefined();

      const rows = await sql`SELECT album_id FROM ${sql(SCHEMA)}.reviews WHERE album_id IN (${a}, ${b})`;
      expect(rows).toHaveLength(1);
      expect(rows[0].album_id).toBe(plan.survivorId);
    });

    it('resolves an active rotation collision without destroying killed history', async () => {
      const a = await seedAlbum({ title: 'Sonido Cosmico', codeNumber: 13 });
      const b = await seedAlbum({ title: 'Sonido Cosmico', codeNumber: 13 });
      // Both active in the same bin — the partial unique index applies here.
      for (const id of [a, b]) {
        await sql`
          INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, add_date)
          VALUES (${id}, 'H', now())
        `;
      }
      // Killed rows in the SAME bin are outside the index's predicate and must
      // survive: they are the rotation history the job promises to preserve.
      await sql`
        INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, add_date, kill_date)
        VALUES (${b}, 'H', now() - interval '90 days', now() - interval '60 days')
      `;

      const plan = (await merge.planSlots([await slotFor(13)]))[0];
      await expect(merge.mergeSlot(plan)).resolves.toBeDefined();

      const active = await sql`
        SELECT album_id FROM ${sql(SCHEMA)}.rotation
         WHERE album_id IN (${a}, ${b}) AND kill_date IS NULL
      `;
      expect(active).toHaveLength(1);
      expect(active[0].album_id).toBe(plan.survivorId);

      const killed = await sql`
        SELECT album_id FROM ${sql(SCHEMA)}.rotation
         WHERE album_id IN (${a}, ${b}) AND kill_date IS NOT NULL
      `;
      expect(killed).toHaveLength(1);
      expect(killed[0].album_id).toBe(plan.survivorId);
    });

    it('repoints library_identity, the site that would otherwise BLOCK the delete', async () => {
      await seedAlbum({ title: 'Amaru', codeNumber: 8 });
      const lose = await seedAlbum({ title: 'Amaru', codeNumber: 8 });
      await sql`
        INSERT INTO ${sql(SCHEMA)}.library_identity (library_id, last_verified_at, method, confidence)
        VALUES (${lose}, now(), 'test', 1.0)
      `;

      const plan = (await merge.planSlots([await slotFor(8)]))[0];
      await expect(merge.mergeSlot(plan)).resolves.toBeDefined();

      const rows = await sql`
        SELECT library_id FROM ${sql(SCHEMA)}.library_identity WHERE library_id = ${plan.survivorId}
      `;
      expect(rows).toHaveLength(1);
    });
  });

  describe('the slot key', () => {
    it('does not treat the same number under a different genre as a collision', async () => {
      await seedAlbum({ title: 'Rock filing', codeNumber: 21, genreId: GENRE_ID });
      await seedAlbum({ title: 'Jazz filing', codeNumber: 21, genreId: OTHER_GENRE_ID });

      expect(await slotFor(21, GENRE_ID)).toBeUndefined();
      expect(await slotFor(21, OTHER_GENRE_ID)).toBeUndefined();
    });

    it('treats volume letters differing only by case as one slot', async () => {
      await seedAlbum({ title: 'Dancehall 101 Vol. 4', codeNumber: 22, vol: 'D' });
      await seedAlbum({ title: 'Dancehall 101, volume 4', codeNumber: 22, vol: 'd' });

      const slot = await slotFor(22);
      expect(slot).toBeDefined();
      expect(slot.members).toHaveLength(2);
      expect(slot.vol).toBe('D');
    });
  });

  describe('renumbering', () => {
    it('moves the genuinely-different release to a free number and leaves the other', async () => {
      const keep = await seedAlbum({ title: 'Wrong Place', codeNumber: 9 });
      const move = await seedAlbum({ title: 'Event II', codeNumber: 9 });

      const plan = (await merge.planSlots([await slotFor(9)]))[0];
      expect(plan.kind).toBe('renumber');
      expect(await merge.renumberRow(plan)).toBe(true);

      const rows = await sql`
        SELECT id, code_number FROM ${sql(SCHEMA)}.library WHERE id IN (${keep}, ${move}) ORDER BY id
      `;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.code_number]));
      expect(byId[plan.keepId]).toBe(9);
      expect(byId[plan.moveId]).toBe(plan.newNumber);
      expect(plan.newNumber).toBeGreaterThan(9);
    });

    it('declines a renumber whose destination was taken after the plan was built', async () => {
      await seedAlbum({ title: 'Kaira', codeNumber: 10 });
      await seedAlbum({ title: 'A Curva da Cintura', codeNumber: 10 });

      const plan = (await merge.planSlots([await slotFor(10)]))[0];
      expect(plan.kind).toBe('renumber');
      // A librarian files into the destination between plan and execute.
      await seedAlbum({ title: 'Filed first', codeNumber: plan.newNumber });

      expect(await merge.renumberRow(plan)).toBe(false);
      const [row] = await sql`SELECT code_number FROM ${sql(SCHEMA)}.library WHERE id = ${plan.moveId}`;
      expect(row.code_number).toBe(10);
    });
  });

  // The job's central safety claim is that repointing must precede deletion,
  // and the force of that claim rests entirely on which sites cascade. That
  // fact cannot be read off `schema.ts`: it declares
  // `artist_library_crossreference.library_id` as `cascade` while the database
  // enforces `no action` (BS#2015, one of four such drifts). Nor can it be read
  // off the migration that first created a constraint — `album_metadata` was
  // created `no action`, dropped with its table, then recreated `cascade` three
  // migrations later. So the delete actions are pinned here against the live
  // catalog, which is the only authority, and this test fails if either the
  // database or the FK_TARGETS list moves out from under the README's table.
  describe('enforced-fk-actions', () => {
    const EXPECTED = {
      rotation: 'CASCADE',
      album_metadata: 'CASCADE',
      reviews: 'CASCADE',
      album_critic_reviews: 'CASCADE',
      compilation_track_artist: 'CASCADE',
      flowsheet: 'SET NULL',
      album_review_submissions: 'SET NULL',
      artist_library_crossreference: 'NO ACTION',
      bins: 'NO ACTION',
      library_identity: 'NO ACTION',
      library_identity_source: 'NO ACTION',
    };

    it('matches the delete actions the database actually enforces', async () => {
      const rows = await sql`
        SELECT tc.table_name, rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
           AND rc.constraint_schema = tc.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = ${SCHEMA}
           AND ccu.table_name = 'library'
           AND ccu.column_name = 'id'
      `;
      const actual = Object.fromEntries(rows.map((r) => [r.table_name, r.delete_rule]));
      for (const [table, rule] of Object.entries(EXPECTED)) {
        expect({ table, rule: actual[table] }).toEqual({ table, rule });
      }
    });

    // Runs FROM the catalog TO the code, which is the only direction that can
    // catch an omission. The previous shape iterated the hardcoded map, so an
    // FK the database has and FK_TARGETS lacks passed green.
    it('finds no FK on library.id that FK_TARGETS does not repoint', async () => {
      const rows = await sql`
        SELECT tc.table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = ${SCHEMA}
           AND ccu.table_name = 'library'
           AND ccu.column_name = 'id'
      `;
      const targets = new Set(merge.FK_TARGETS.map((t) => t.table));
      const missing = [...new Set(rows.map((r) => r.table_name))].filter((t) => !targets.has(t)).sort();
      expect(missing).toEqual([]);
    });

    // The ordering invariant was pinned; the COLLISION invariant was not, which
    // is exactly how `reviews` (plain UNIQUE) and `rotation` (PARTIAL unique)
    // shipped with `uniqueKey: null`. A repoint into a taken key raises and
    // aborts the whole run, so every uniqueness constraint touching a target
    // column has to be declared.
    it('declares a uniqueKey for every uniqueness constraint on a target column', async () => {
      const rows = await sql`
        SELECT t.relname AS table_name,
               array_agg(a.attname ORDER BY a.attnum) AS cols,
               (i.indpred IS NOT NULL) AS is_partial,
               pg_get_expr(i.indpred, i.indrelid) AS pred
          FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
         WHERE i.indisunique
           AND n.nspname = ${SCHEMA}
         GROUP BY t.relname, i.indexrelid, i.indpred
      `;
      const undeclared = [];
      for (const target of merge.FK_TARGETS) {
        for (const idx of rows) {
          if (idx.table_name !== target.table) continue;
          if (!idx.cols.includes(target.column)) continue;
          const declared = target.uniqueKey ?? [];
          const covers = idx.cols.every((c) => declared.includes(c));
          const partialHandled = !idx.is_partial || Boolean(target.uniqueWhenNull);
          if (!covers || !partialHandled) {
            undeclared.push(
              `${target.table}.${target.column} vs [${idx.cols.join(',')}]${idx.is_partial ? ' (partial)' : ''}`
            );
          }
        }
      }
      expect(undeclared.sort()).toEqual([]);
    });
  });

  it('is idempotent — a merged slot drops out of the collision scan', async () => {
    await seedAlbum({ title: 'DOGA', codeNumber: 11 });
    await seedAlbum({ title: 'DOGA', codeNumber: 11 });

    const plan = (await merge.planSlots([await slotFor(11)]))[0];
    await merge.mergeSlot(plan);

    expect(await slotFor(11)).toBeUndefined();
  });
});
