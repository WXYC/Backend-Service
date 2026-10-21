/**
 * `label_id` against `record_label` on `POST /intake` and `PATCH /intake/{id}` (BS#3583), against real rows: a request that
 * carries both is refused with a 400 `label_mismatch` unless the label's name matches `record_label`, compared case-insensitively
 * on trimmed text. A request with only one of the two is unchanged, and a `label_id` that names no label stays the existing
 * `unknown_reference` 400. The controller's decision of when to check is pinned by `tests/unit/controllers/intake.label.controller.test.ts`.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { managerAccessToken } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-INTAKE-LABEL';
const LABEL_NAME = `${PREFIX} Drag City`;

describe('/intake label_id and record_label (BS#3583)', () => {
  let auth;
  let sql;
  let formatId;
  let labelId;

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".labels WHERE label_name = $1`, [LABEL_NAME]);
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    await cleanup();
    [{ id: formatId }] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);
    [{ id: labelId }] = await sql.unsafe(`INSERT INTO "${SCHEMA}".labels (label_name) VALUES ($1) RETURNING id`, [
      LABEL_NAME,
    ]);
  });

  afterAll(cleanup);

  const logged = async (body = {}) => {
    const res = await auth
      .post('/intake')
      .send({ artist_name: `${PREFIX} item`, album_title: 'On Your Own Love Again', format_id: formatId, ...body });
    expect(res.status).toBe(200);
    return res.body;
  };

  /** Sends `body` as a new item (POST) or as an edit of a fresh, unlabelled one (PATCH). */
  const VERBS = [
    [
      'POST /intake',
      (body) =>
        auth.post('/intake').send({ artist_name: `${PREFIX} post`, album_title: 'X', format_id: formatId, ...body }),
    ],
    ['PATCH /intake/{id}', async (body) => auth.patch(`/intake/${(await logged()).id}`).send(body)],
  ];

  describe.each(VERBS)('%s', (_verb, send) => {
    test.each([
      ['the matching name', () => ({ label_id: labelId, record_label: LABEL_NAME })],
      [
        'the name in other case with outer whitespace',
        () => ({ label_id: labelId, record_label: `  ${LABEL_NAME.toLowerCase()} ` }),
      ],
      ['label_id only', () => ({ label_id: labelId })],
      ['record_label only', () => ({ record_label: 'Sonamos' })],
    ])('accepts %s', async (_name, body) => {
      const res = await send(body());
      expect(res.status).toBe(200);
    });

    test('refuses a mismatched name with a 400 label_mismatch and writes nothing', async () => {
      const before = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".intake_items WHERE label_id = $1`, [
        labelId,
      ]);
      const res = await send({ label_id: labelId, record_label: 'Sonamos' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('label_mismatch');
      const after = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".intake_items WHERE label_id = $1`, [
        labelId,
      ]);
      expect(after[0].n).toBe(before[0].n);
    });

    test('keeps unknown_reference for a label_id that names no label', async () => {
      const res = await send({ label_id: 2147483000, record_label: LABEL_NAME });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('format_id or label_id does not exist');
    });
  });
});
