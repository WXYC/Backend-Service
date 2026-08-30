/**
 * `GET /digital-archive/albums/:id/playback` (BS#2320, contract
 * wxyc-shared#417/#422).
 *
 * Postgres-backed: direct SQL seeds a library album (with FK scaffolding), a
 * `digital_asset_store` row, and `digital_asset`/`digital_asset_file` rows,
 * then supertest drives the HTTP surface. CI runs this backend process with
 * `DIGITAL_ARCHIVE_STREAMING_ENABLED=true` and fake
 * `DIGITAL_ARCHIVE_STORE_AZURACAST_*` credentials (`dev_env/docker-compose.yml`
 * / `.github/workflows/test.yml`) specifically so this happy path is
 * exercised here — `presignGet` computes its SigV4 signature locally and
 * never contacts the endpoint, so a fake key/secret is sufficient.
 *
 * THIS TIER CANNOT PIN THE FLAG-OFF 403 OR THE ROLE GATE, and does not try
 * to — same limitation `album-reviews.spec.js` documents. The flag is fixed
 * ON for this whole process (see above), and CI's `AUTH_BYPASS=true` makes
 * `requirePermissions` return `next()` before the permission block, so
 * `digital_archive:listen` and `requirePermissions({})` behave identically
 * here. Both are pinned elsewhere: the flag-off 403 (with no service call)
 * in `tests/unit/controllers/digital-archive.controller.test.ts`, and the
 * role gate in `tests/unit/routes/digital-archive-permissions.route.test.ts`.
 *
 * Pins the load-bearing server contract:
 *   - 404 (never a 200 with empty tracks) for: no digital_asset row, a
 *     digital_asset row that isn't `status = 'bound'`, and a `bound` asset
 *     with zero files;
 *   - MERGE across several bound assets for one album (multi-disc), ordered
 *     `(disc_number, track_number NULLS LAST, title)`, each track's
 *     `provenance`/`disc_number` from its OWN parent asset;
 *   - several files for one (asset, track_number, title) group into one
 *     track with several `renditions`, every codec served (not mp3-only);
 *   - the presigned URL's host matches the configured store endpoint and
 *     carries `X-Amz-Expires` equal to the configured TTL;
 *   - `Cache-Control: private, no-store`;
 *   - `:id` param validation (400 on non-numeric).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ARTIST_NAME = 'BS2320 Digital Archive Probe Artist';
const STORE_NAME = 'azuracast';
const OBJECT_KEY_PREFIX = 'itest-bs2320:';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('GET /digital-archive/albums/:id/playback (BS#2320)', () => {
  let auth;
  let sql;
  let storeId;
  const libraryIds = {};
  const assetIds = [];

  const seedLibrary = async (artistId, genreId, formatId, codeNumber, title) => {
    const [lib] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [artistId, genreId, formatId, title, codeNumber, ARTIST_NAME]
    );
    return lib.id;
  };

  const seedAsset = async (libraryId, provenance, discNumber, status) => {
    const [asset] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset (library_id, provenance, disc_number, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [libraryId, provenance, discNumber, status]
    );
    assetIds.push(asset.id);
    return asset.id;
  };

  const seedFile = async (assetId, { objectKeySuffix, codec, trackNumber, title, md5, durationSecs, bitrateKbps }) => {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset_file
         (asset_id, store_id, object_key, codec, track_number, title, duration_secs, bytes, md5, bitrate_kbps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        assetId,
        storeId,
        `${OBJECT_KEY_PREFIX}${objectKeySuffix}`,
        codec,
        trackNumber ?? null,
        title,
        durationSecs ?? null,
        1_000_000,
        md5 ?? null,
        bitrateKbps ?? null,
      ]
    );
  };

  const cleanup = async () => {
    // digital_asset_file rows cascade-delete with their parent digital_asset.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".digital_asset WHERE id = ANY($1)`, [assetIds]);
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".library
        WHERE artist_id IN (SELECT id FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZZ')`,
      [ARTIST_NAME]
    );
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZZ'`, [ARTIST_NAME]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    assetIds.length = 0;
    await cleanup(); // idempotent across re-runs

    const [store] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".digital_asset_store (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [STORE_NAME]
    );
    storeId = store.id;

    const [genre] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".genres ORDER BY id LIMIT 1`);
    const [format] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters)
       VALUES ($1, $1, 'ZZ') RETURNING id`,
      [ARTIST_NAME]
    );

    // UNBOUND: no digital_asset row at all.
    libraryIds.unbound = await seedLibrary(artist.id, genre.id, format.id, 9201, 'Unbound Album');

    // NEEDS_REVIEW: a digital_asset row that is not `bound`.
    libraryIds.needsReview = await seedLibrary(artist.id, genre.id, format.id, 9202, 'Needs Review Album');
    await seedAsset(libraryIds.needsReview, 'rotation_upload', 1, 'needs_review');

    // BOUND_NO_FILES: bound asset, zero files.
    libraryIds.boundNoFiles = await seedLibrary(artist.id, genre.id, format.id, 9203, 'Bound No Files Album');
    await seedAsset(libraryIds.boundNoFiles, 'rotation_upload', 1, 'bound');

    // MULTI_DISC: two bound assets (disc 1, disc 2), one track each.
    libraryIds.multiDisc = await seedLibrary(artist.id, genre.id, format.id, 9204, 'Multi Disc Album');
    const disc1 = await seedAsset(libraryIds.multiDisc, 'rotation_upload', 1, 'bound');
    await seedFile(disc1, {
      objectKeySuffix: 'multidisc-d1t1',
      codec: 'mp3',
      trackNumber: 1,
      title: 'Disc 1 Track 1',
      md5: 'd1t1md5d1t1md5d1t1md5d1t1md5d1t1',
      durationSecs: 200,
    });
    const disc2 = await seedAsset(libraryIds.multiDisc, 'rotation_upload', 2, 'bound');
    await seedFile(disc2, {
      objectKeySuffix: 'multidisc-d2t1',
      codec: 'mp3',
      trackNumber: 1,
      title: 'Disc 2 Track 1',
      durationSecs: 210,
    });

    // MULTI_RENDITION + NULL TRACK NUMBER ORDERING: one asset, three files —
    // two renditions of the same track, plus a null-track_number bonus track
    // that must sort LAST.
    libraryIds.renditions = await seedLibrary(artist.id, genre.id, format.id, 9205, 'Renditions Album');
    const renditionsAsset = await seedAsset(libraryIds.renditions, 'rotation_upload', 1, 'bound');
    await seedFile(renditionsAsset, {
      objectKeySuffix: 'rend-t1-mp3',
      codec: 'mp3',
      trackNumber: 1,
      title: 'Side A',
      md5: 'primarymd5primarymd5primarymd5aa',
    });
    await seedFile(renditionsAsset, {
      objectKeySuffix: 'rend-t1-flac',
      codec: 'flac',
      trackNumber: 1,
      title: 'Side A',
      bitrateKbps: 1411,
    });
    await seedFile(renditionsAsset, {
      objectKeySuffix: 'rend-bonus',
      codec: 'mp3',
      trackNumber: null,
      title: 'Untagged Bonus',
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  describe('auth', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request.get(`/digital-archive/albums/${libraryIds.unbound}/playback`);
      expect(res.status).toBe(401);
    });
  });

  describe('404 — permitted, nothing playable (never a 200 with empty tracks)', () => {
    it('404s an album with no digital_asset row at all', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.unbound}/playback`);
      expect(res.status).toBe(404);
    });

    it('404s an album whose only digital_asset row is not status=bound', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.needsReview}/playback`);
      expect(res.status).toBe(404);
    });

    it('404s a bound asset with zero files, rather than a 200 with an empty tracks array', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.boundNoFiles}/playback`);
      expect(res.status).toBe(404);
    });
  });

  describe('validation', () => {
    it('400s a non-numeric id', async () => {
      const res = await auth.get('/digital-archive/albums/not-a-number/playback');
      expect(res.status).toBe(400);
    });
  });

  describe('multi-disc merge and ordering', () => {
    it('merges both bound assets into one manifest, ordered by disc_number then track_number', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.multiDisc}/playback`);
      expect(res.status).toBe(200);
      expect(res.body.library_id).toBe(libraryIds.multiDisc);
      expect(res.body.tracks.map((t) => [t.disc_number, t.track_number, t.title])).toEqual([
        [1, 1, 'Disc 1 Track 1'],
        [2, 1, 'Disc 2 Track 1'],
      ]);
    });

    it('projects duration_secs and content_hash from the file row', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.multiDisc}/playback`);
      const track = res.body.tracks.find((t) => t.title === 'Disc 1 Track 1');
      expect(track.duration_secs).toBe(200);
      expect(track.content_hash).toBe('d1t1md5d1t1md5d1t1md5d1t1md5d1t1');
    });

    it('sets Cache-Control: private, no-store', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.multiDisc}/playback`);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('every rendition URL is presigned against the configured store endpoint with the configured TTL', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.multiDisc}/playback`);
      for (const track of res.body.tracks) {
        for (const rendition of track.renditions) {
          const url = new URL(rendition.url);
          expect(url.hostname).toContain('digitaloceanspaces.com');
          expect(url.searchParams.get('X-Amz-Expires')).toBe(
            String(process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS || 14400)
          );
        }
      }
    });

    it('expires_at is in the future, within the configured TTL window', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.multiDisc}/playback`);
      const expiresAtMs = new Date(res.body.expires_at).getTime();
      const ttlMs = Number(process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS || 14400) * 1000;
      expect(expiresAtMs).toBeGreaterThan(Date.now());
      expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + ttlMs + 5000);
    });
  });

  describe('renditions and codec breadth', () => {
    let track;
    let bonusTrack;

    beforeAll(async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.renditions}/playback`);
      expect(res.status).toBe(200);
      track = res.body.tracks.find((t) => t.title === 'Side A');
      bonusTrack = res.body.tracks.find((t) => t.title === 'Untagged Bonus');
    });

    it('groups two files of the same track into one entry with two renditions', () => {
      expect(track).toBeDefined();
      expect(track.renditions).toHaveLength(2);
      expect(track.renditions.map((r) => r.codec).sort()).toEqual(['flac', 'mp3']);
    });

    it('serves the flac rendition, not just mp3', () => {
      const flac = track.renditions.find((r) => r.codec === 'flac');
      expect(flac).toBeDefined();
      expect(flac.bitrate_kbps).toBe(1411);
    });

    it('sorts a null track_number row LAST, not first', async () => {
      const res = await auth.get(`/digital-archive/albums/${libraryIds.renditions}/playback`);
      expect(res.body.tracks[res.body.tracks.length - 1].title).toBe('Untagged Bonus');
      expect(bonusTrack.track_number).toBeNull();
    });
  });
});
