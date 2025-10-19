require('dotenv').config({ path: '../../.env' });
// WSL compatibility: use Windows host IP instead of localhost
const getWindowsHostIP = () => {
  const { execSync } = require('child_process');
  try {
    const result = execSync("ip route show | grep default | awk '{print $3}'", { encoding: 'utf8' });
    return result.trim();
  } catch (error) {
    return '127.0.0.1';
  }
};

const windowsHost = getWindowsHostIP();
const testUrl = `http://${windowsHost}:${process.env.CI_PORT || 8081}`;
const request = require('supertest')(testUrl);
const fls_util = require('../utils/flowsheet_util');

/*
 * Start Show (Primary dj hits /flowsheet/join)
 */
describe('Start Show', () => {
  // Clean up by ending show
  afterEach(async () => {
    console.log('[TEST] Start Show afterEach starting');
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
    console.log('[TEST] Start Show afterEach complete');
  });

  test('Properly Formatted Request', async () => {
    const res = await global.setAuthHeader(request
      .post('/flowsheet/join'))
      .send({
        dj_id: global.primary_dj_id,
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

/*
 * Join Show (Secondary dj(s) hits /flowsheet/join)
 */
describe('Join Show', () => {
  beforeEach(async () => {
    // Start show with primary dj
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    // Clean up and end show
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.secondary_dj_id,
      })
      .expect(200);
  });
});

/*
 * End Show (Primary dj hits /flowsheet/end)
 */
describe('End Show', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  // Ensure that primary dj ends the show for all show djs
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Primary DJ Leaves', async () => {
    await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
      })
      .expect(200);
  });

  test('No Active Show Session', async () => {
    // End active show
    await request.post('/flowsheet/end').set('Authorization', global.access_token).send({
      dj_id: global.primary_dj_id,
    });

    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.secondary_dj_id,
      })
      .expect(404);
    expect(res.body.message).toBeDefined();
  });
});

/*
 * Leave Show (Secondary dj hits /flowsheet/end)
 */
describe('Leave Show', () => {
  beforeEach(async () => {
    // Start show
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    // Second DJ joins
    await fls_util.join_show(global.secondary_dj_id, global.access_token);
  });

  // Ensure that primary dj ends the show for all show djs
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly formatted request', async () => {
    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
      })
      .expect(200);
  });

  test('DJ not in show', async () => {
    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: 1000,
      })
      .expect(400);
    expect(res.body.message).toBeDefined();
  });

  test('No Active Show Session', async () => {
    // End active show
    await request.post('/flowsheet/end').set('Authorization', global.access_token).send({
      dj_id: global.primary_dj_id,
    });

    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.secondary_dj_id,
      })
      .expect(404);
    expect(res.body.message).toBeDefined();
  });
});

/*
 * Add Flowsheet Entries
 */
describe('Add to Flowsheet', () => {
  // Setup: Start Show
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  // Cleanup: End Show
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('With Album ID', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        // record_label: 'Warner Bros',
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
  });

  test('With Album ID && Rotation ID', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        rotation_id: 1,
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
  });

  test('With Album ID & Record Label', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        record_label: 'Warner Bros',
      })
      .expect(200);

    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
    expect(res.body.record_label).toEqual('Warner Bros');
  });

  test('With Album ID & Request Flag', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        request_flag: true,
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.request_flag).toBeTruthy();
  });

  test('With Album Title & Artist Name', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Build to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
  });

  test('With Album Title, Artist Name, & Record Label', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Build to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
        record_label: 'Warner Bros',
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
    expect(res.body.record_label).toEqual('Warner Bros');
  });

  test('With Album Title, Artist Name, & Request Flag', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Build to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
        request_flag: true,
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
  });

  test('Flowsheet Message', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        message: 'Test Message',
      })
      .expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.message).toEqual('Test Message');
    // These are empty strings as of now, but should be null
    // expect(res.body.artist_name).toBeNull();
    // expect(res.body.album_title).toBeNull();
    // expect(res.body.track_title).toBeNull();
  });
});

/*
 * Retrieve Flowsheet Entries
 */
describe('Retrieve Flowsheet Entries', () => {
  beforeEach(async () => {
    // first show
    const res = await fls_util.join_show(global.primary_dj_id, global.access_token);
    res.body.id;
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 1, //Built to Spill - Keep it Like a Secret
      track_title: 'The Plan',
    });

    // second show
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 2, //Ravyn Lenae - Crush
      track_title: 'Venom',
    });
    await fls_util.leave_show(global.primary_dj_id, global.access_token);

    // third show
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 3, //Jockstrap - I Love You Jennifer B
      track_title: 'Debra',
    });
    await fls_util.leave_show(global.primary_dj_id, global.access_token);

    // fourth show
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 1, //Built to Spill - Keep it Like a Secret
      track_title: 'Carry the Zero',
    });
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request w/o Query Param', async () => {
    const res = await request.get('/flowsheet').send().expect(200);

    expect(res.body.length).toEqual(30);
  });

  test('Properly Formatted Request w/ 3 entries', async () => {
    const res = await request.get('/flowsheet').query({ limit: 3 }).send().expect(200);

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

  test('Get entries from 3 latest shows', async () => {
    const res = await request.get('/flowsheet').query({ shows_limit: 3 }).send().expect(200);

    // Should include entries from current show and previous 2 shows
    expect(res.body.length).toBeGreaterThan(0);

    // Check that we have entries from all 3 shows
    const showIds = [...new Set(res.body.map((entry) => entry.show_id))];
    expect(showIds.length).toBe(3);

    // Verify the content of entries
    const songEntries = res.body.filter((entry) => !entry.message);
    expect(songEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artist_name: 'Jockstrap',
          album_title: 'I Love You Jennifer B',
          track_title: 'Debra',
        }),
        expect.objectContaining({
          artist_name: 'Ravyn Lenae',
          album_title: 'Crush',
          track_title: 'Venom',
        }),
        expect.objectContaining({
          artist_name: 'Built to Spill',
          album_title: 'Keep it Like a Secret',
          track_title: 'Carry the Zero',
        }),
      ])
    );
  });

  test('Get entries from 2 shows using pagination', async () => {
    const res = await request.get('/flowsheet').query({ shows_limit: 2, page: 1 }).send().expect(200);

    // Should include entries from current show and previous 2 shows
    expect(res.body.length).toBeGreaterThan(0);

    // Check that we have entries from all 3 shows
    const showIds = [...new Set(res.body.map((entry) => entry.show_id))];
    expect(showIds.length).toBe(2);

    // Verify the content of entries
    const songEntries = res.body.filter((entry) => !entry.message);
    expect(songEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artist_name: 'Ravyn Lenae',
          album_title: 'Crush',
          track_title: 'Venom',
        }),
        expect.objectContaining({
          artist_name: 'Built to Spill',
          album_title: 'Keep it Like a Secret',
          track_title: 'The Plan',
        }),
      ])
    );
  });

  test('Invalid shows_limit parameter', async () => {
    await request.get('/flowsheet').query({ shows_limit: 'invalid' }).send().expect(400);

    await request.get('/flowsheet').query({ shows_limit: -1 }).send().expect(400);

    await request.get('/flowsheet').query({ shows_limit: 0 }).send().expect(400);
  });
});

describe('Delete Flowsheet Entries', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    const res = await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 1, //Built to Spill - Keep it Like a Secret
      track_title: 'Carry the Zero',
    });

    global.entry_to_delete_id = res.body.id;
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const delete_res = await request
      .delete('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id: global.entry_to_delete_id,
      })
      .expect(200);

    expect(delete_res.body).toBeDefined();
    expect(delete_res.body.id).toEqual(global.entry_to_delete_id);
    expect(delete_res.body.album_id).toEqual(1);

    const get_res = await request
      .get('/flowsheet')
      .set('Authorization', global.access_token)
      .query({ limit: 1 })
      .send()
      .expect(200);

    expect(get_res.body[0].id).toEqual(Number(global.entry_to_delete_id) - 1);
  });
});

describe('Retrieve Now Playing', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
      })
      .expect(200);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    let res = await request.get('/flowsheet/latest').expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.artist_name).toEqual('Built to Spill');
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');

    // add a new track
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2, //Ravyn Lenae - Crush
        track_title: 'Venom',
      })
      .expect(200);

    res = await request.get('/flowsheet/latest').expect(200);
    expect(res.body).toBeDefined();
    expect(res.body.artist_name).toEqual('Ravyn Lenae');
    expect(res.body.album_title).toEqual('Crush');
    expect(res.body.track_title).toEqual('Venom');
  });
});

describe('Shift Flowsheet Entries', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    // Insert entries to move around
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
      })
      .expect(200);

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2, //Ravyn Lenae - Crush
        track_title: 'Venom',
      })
      .expect(200);

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 3, //Jockstrap - I Love You Jennifer B
        track_title: 'Debra',
      })
      .expect(200);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Start > Destination', async () => {
    let get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    const entries = get_entries_res.body;

    const res = await request
      .patch('/flowsheet/play-order')
      .send({ entry_id: entries[0].id, new_position: entries[2].play_order })
      .expect(200);

    expect(res.body.play_order).toEqual(entries[2].play_order);
  });

  test('Destination > Start', async () => {
    let get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    const entries = get_entries_res.body;
    const res = await request
      .patch('/flowsheet/play-order')
      .send({ entry_id: entries[2].id, new_position: entries[0].play_order })
      .expect(200);

    // get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    expect(res.body.play_order).toEqual(entries[0].play_order);
  });
});

describe('Retrieve Playlist Object', () => {
  beforeEach(async () => {
    // setup show
    const res = await fls_util.join_show(global.primary_dj_id, global.access_token);
    const body = await res.json();
    global.CurrentShowID = body.id;

    await fls_util.join_show(global.secondary_dj_id, global.access_token);

    // Insert entry to for show
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 3, //Jockstrap - I Love You Jennifer B
        track_title: 'Debra',
      })
      .expect(200);

    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const playlist = await request
      .get('/flowsheet/playlist')
      .query({ show_id: global.CurrentShowID })
      .send()
      .expect(200);

    expect(playlist.body.show_djs).toEqual([
      { id: 1, dj_name: 'Test dj1' },
      { id: 2, dj_name: 'Test dj2' },
    ]);

    expect(playlist.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/Start of Show:.*joined the set at/) }),
        expect.objectContaining({ message: expect.stringMatching(/.* joined the set!/) }),
        expect.objectContaining({ artist_name: 'Jockstrap' }),
        expect.objectContaining({ message: expect.stringMatching(/.* left the set!/) }),
        expect.objectContaining({ message: expect.stringMatching(/End of Show:.*left the set at/) }),
      ])
    );
    expect(new Date(playlist.body.date)).toBeInstanceOf(Date);
  });
});
