require('dotenv').config({ path: '../../.env' });
const request = require('supertest')('http://localhost:8080');

describe('Start Show', () => {
  //clean up
  afterEach(async () => {
    await request.post('/flowsheet/end').set('Authorization', global.access_token).send({
      dj_id: 1,
    });
  });

  test('Properly Formatted Request', async () => {
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: 1,
        show_name: 'test_show',
      })
      .expect(200);

    expect(res.body.id).toBeDefined();
    expect(res.body.primary_dj_id).toBeDefined();
    expect(res.body.start_time).toBeDefined();
    expect(res.body.show_name).toEqual('test_show');
    expect(res.body.end_time).toBeNull();
  });
});

describe('Retrieve N Flowsheet Entries', () => {
  beforeEach(async () => {
    const show_req = await request.post('/flowsheet/join').set('Authorization', global.access_token).send({
      dj_id: 1,
    });

    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      show_id: show_req.body.show_id,
      album_id: 32864, //Built to Spill - Keep it Like a Secret
      track_title: 'Carry the Zero',
    });

    await request.post('/flowsheet/end').set('Authorization', global.access_token).send({
      dj_id: 1,
    });
  });

  test('Properly Formatted Request w/ 3 entries', async () => {
    //host to test
    const res = await request
      .get('/flowsheet') // API endpoint
      .query({ limit: 3 })
      .send() // request body
      .expect(200);

    expect(res.body[0].show_id).not.toBeNull();
    expect(res.body[1].show_id).not.toBeNull();
    expect(res.body[2].show_id).not.toBeNull();

    expect(res.body[0].message).toMatch(
      /End of Show: .* left the set at (0?[2-9]|1[0-2]?)\/(0?[1-9]|[1-2][0-9]|3[0-1])\/\d\d\d\d, (0?\d|1[0-2]):(0?\d|[1-5]\d):(0?\d|[1-5]\d) (AM|PM)/
    );
    expect(res.body[1].message).toBeNull();
    expect(res.body[2].message).toMatch(
      /Start of Show: .* joined the set at (0?[2-9]|1[0-2]?)\/(0?[1-9]|[1-2][0-9]|3[0-1])\/\d\d\d\d, (0?\d|1[0-2]):(0?\d|[1-5]\d):(0?\d|[1-5]\d) (AM|PM)/
    );

    expect(res.body[1].artist_name).toEqual('Built to Spill');
    expect(res.body[1].album_title).toEqual('Keep it Like a Secret');
    expect(res.body[1].track_title).toEqual('Carry the Zero');

    expect(res.body.length).toEqual(3);
  });
});
