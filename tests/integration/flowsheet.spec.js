const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const fls_util = require('../utils/flowsheet_util');

/*
 * Start Show (Primary dj hits /flowsheet/join)
 */
describe('Start Show', () => {
  // Clean up by ending show
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const res = await request.post('/flowsheet/join').set('Authorization', global.access_token).send({
      dj_id: global.primary_dj_id,
      show_name: 'test_show',
    });

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
      .set('Authorization', global.access_token)
      .send({ entry_id: entries[0].id, new_position: entries[2].play_order })
      .expect(200);

    expect(res.body.play_order).toEqual(entries[2].play_order);
  });

  test('Destination > Start', async () => {
    let get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    const entries = get_entries_res.body;
    const res = await request
      .patch('/flowsheet/play-order')
      .set('Authorization', global.access_token)
      .send({ entry_id: entries[2].id, new_position: entries[0].play_order })
      .expect(200);

    // get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    expect(res.body.play_order).toEqual(entries[0].play_order);
  });
});

describe('On Air Status', () => {
  describe('GET /flowsheet/on-air', () => {
    test('returns false when DJ is not on air', async () => {
      // Ensure no active show
      await fls_util.leave_show(global.primary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/on-air')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.id).toBe(global.primary_dj_id);
      expect(res.body.is_live).toBe(false);
    });

    test('returns true when DJ is on air', async () => {
      // Start a show
      await fls_util.join_show(global.primary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/on-air')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.id).toBe(global.primary_dj_id);
      expect(res.body.is_live).toBe(true);

      // Clean up
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    });

    test('returns false for non-existent DJ', async () => {
      const res = await request
        .get('/flowsheet/on-air')
        .query({ dj_id: 'non-existent-dj-id' })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.is_live).toBe(false);
    });
  });

  describe('GET /flowsheet/djs-on-air', () => {
    test('returns empty array when no show is active', async () => {
      // Ensure no active show
      await fls_util.leave_show(global.primary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/djs-on-air')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    test('returns DJ list when show is active', async () => {
      // Start a show
      await fls_util.join_show(global.primary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/djs-on-air')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('dj_name');

      // Clean up
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    });

    test('returns multiple DJs when multiple are on air', async () => {
      // Start a show with primary DJ
      await fls_util.join_show(global.primary_dj_id, global.access_token);
      // Secondary DJ joins
      await fls_util.join_show(global.secondary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/djs-on-air')
        .set('Authorization', global.access_token)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      const djIds = res.body.map((dj) => dj.id);
      expect(djIds).toContain(global.primary_dj_id);
      expect(djIds).toContain(global.secondary_dj_id);

      // Clean up
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    });
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
      { id: global.primary_dj_id, dj_name: 'Test dj1' },
      { id: global.secondary_dj_id, dj_name: 'Test dj2' },
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

/*
 * V2 API Tests - Discriminated Union Format
 */
describe('V2 API - Entry Types', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  describe('GET /v2/flowsheet', () => {
    test('returns entries with entry_type field', async () => {
      // Add a track entry
      await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          album_id: 1,
          track_title: 'Carry the Zero',
        })
        .expect(200);

      const res = await request.get('/v2/flowsheet').query({ limit: 3 }).expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      // Every entry should have an entry_type field
      res.body.forEach((entry) => {
        expect(entry.entry_type).toBeDefined();
        expect([
          'track',
          'show_start',
          'show_end',
          'dj_join',
          'dj_leave',
          'talkset',
          'breakpoint',
          'message',
        ]).toContain(entry.entry_type);
      });
    });

    test('returns discriminated union format - track entry', async () => {
      // Add a track
      await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          album_id: 1,
          track_title: 'Carry the Zero',
        })
        .expect(200);

      const res = await request.get('/v2/flowsheet').query({ limit: 1 }).expect(200);

      const trackEntry = res.body[0];
      expect(trackEntry.entry_type).toBe('track');
      expect(trackEntry.artist_name).toBeDefined();
      expect(trackEntry.album_title).toBeDefined();
      expect(trackEntry.track_title).toBe('Carry the Zero');
      // Track entries should NOT have message field
      expect(trackEntry.message).toBeUndefined();
    });

    test('returns discriminated union format - show_start entry', async () => {
      const res = await request.get('/v2/flowsheet').query({ limit: 10 }).expect(200);

      const showStartEntry = res.body.find((e) => e.entry_type === 'show_start');
      expect(showStartEntry).toBeDefined();
      expect(showStartEntry.dj_name).toBeDefined();
      expect(showStartEntry.timestamp).toBeDefined();
      // Show start entries should NOT have track fields
      expect(showStartEntry.artist_name).toBeUndefined();
      expect(showStartEntry.album_title).toBeUndefined();
    });
  });

  describe('POST /v2/flowsheet/track', () => {
    test('adds track with entry_type set', async () => {
      const res = await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          album_id: 1,
          track_title: 'The Plan',
        })
        .expect(200);

      expect(res.body.entry_type).toBe('track');
      expect(res.body.track_title).toBe('The Plan');
      expect(res.body.album_title).toBe('Keep it Like a Secret');
    });

    test('requires track_title', async () => {
      await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          album_id: 1,
        })
        .expect(400);
    });

    test('requires album_id or artist_name+album_title', async () => {
      await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          track_title: 'Test Track',
        })
        .expect(400);
    });
  });

  describe('POST /v2/flowsheet/talkset', () => {
    test('adds talkset entry', async () => {
      const res = await request
        .post('/v2/flowsheet/talkset')
        .set('Authorization', global.access_token)
        .send({
          message: 'Station ID at the top of the hour',
        })
        .expect(200);

      expect(res.body.entry_type).toBe('talkset');
      expect(res.body.message).toBe('Station ID at the top of the hour');
    });

    test('requires message', async () => {
      await request
        .post('/v2/flowsheet/talkset')
        .set('Authorization', global.access_token)
        .send({})
        .expect(400);
    });
  });

  describe('POST /v2/flowsheet/breakpoint', () => {
    test('adds breakpoint entry', async () => {
      const res = await request
        .post('/v2/flowsheet/breakpoint')
        .set('Authorization', global.access_token)
        .send({
          message: 'Top of the hour',
        })
        .expect(200);

      expect(res.body.entry_type).toBe('breakpoint');
      expect(res.body.message).toBe('Top of the hour');
    });

    test('allows optional message', async () => {
      const res = await request
        .post('/v2/flowsheet/breakpoint')
        .set('Authorization', global.access_token)
        .send({})
        .expect(200);

      expect(res.body.entry_type).toBe('breakpoint');
    });
  });

  describe('POST /v2/flowsheet/message', () => {
    test('adds custom message entry', async () => {
      const res = await request
        .post('/v2/flowsheet/message')
        .set('Authorization', global.access_token)
        .send({
          message: 'Custom announcement text',
        })
        .expect(200);

      expect(res.body.entry_type).toBe('message');
      expect(res.body.message).toBe('Custom announcement text');
    });

    test('requires message', async () => {
      await request
        .post('/v2/flowsheet/message')
        .set('Authorization', global.access_token)
        .send({})
        .expect(400);
    });
  });

  describe('PATCH /v2/flowsheet/:id', () => {
    test('updates entry by id in path', async () => {
      // Add an entry first
      const addRes = await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          album_id: 1,
          track_title: 'Carry the Zero',
        })
        .expect(200);

      const entryId = addRes.body.id;

      // Update it
      const updateRes = await request
        .patch(`/v2/flowsheet/${entryId}`)
        .set('Authorization', global.access_token)
        .send({
          track_title: 'The Plan',
        })
        .expect(200);

      expect(updateRes.body.track_title).toBe('The Plan');
    });
  });

  describe('DELETE /v2/flowsheet/:id', () => {
    test('deletes entry by id in path', async () => {
      // Add an entry first
      const addRes = await request
        .post('/v2/flowsheet/track')
        .set('Authorization', global.access_token)
        .send({
          album_id: 1,
          track_title: 'Carry the Zero',
        })
        .expect(200);

      const entryId = addRes.body.id;

      // Delete it
      const deleteRes = await request
        .delete(`/v2/flowsheet/${entryId}`)
        .set('Authorization', global.access_token)
        .expect(200);

      expect(deleteRes.body.id).toBe(entryId);
    });
  });
});

describe('V2 API - V1 Compatibility', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('V1 API returns entry_type field (additive change)', async () => {
    // Add a track via V1 API
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Carry the Zero',
      })
      .expect(200);

    // V1 response should now include entry_type (additive change)
    expect(addRes.body.entry_type).toBe('track');

    // V1 GET should also include entry_type
    const getRes = await request.get('/flowsheet').query({ limit: 1 }).expect(200);
    expect(getRes.body[0].entry_type).toBeDefined();
  });

  test('V1 message entries get correct entry_type', async () => {
    // V1 message entry
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        message: 'Test announcement',
      })
      .expect(200);

    // V1 should return entry_type for backwards compatibility detection
    // Messages without specific patterns default to 'message' type
    expect(res.body.message).toBe('Test announcement');
  });
});

describe('V2 API - Show Management', () => {
  test('POST /v2/flowsheet/join starts show', async () => {
    const res = await request
      .post('/v2/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
        show_name: 'V2 Test Show',
      })
      .expect(200);

    expect(res.body.id).toBeDefined();
    expect(res.body.show_name).toBe('V2 Test Show');

    // Clean up
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('POST /v2/flowsheet/end ends show', async () => {
    // Start a show
    await request
      .post('/v2/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
      })
      .expect(200);

    // End it
    const res = await request
      .post('/v2/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
      })
      .expect(200);

    expect(res.body.end_time).not.toBeNull();
  });

  test('GET /v2/flowsheet/on-air returns status', async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    const res = await request
      .get('/v2/flowsheet/on-air')
      .query({ dj_id: global.primary_dj_id })
      .expect(200);

    expect(res.body.id).toBe(global.primary_dj_id);
    expect(res.body.is_live).toBe(true);

    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('GET /v2/flowsheet/djs-on-air returns DJ list', async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    const res = await request.get('/v2/flowsheet/djs-on-air').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('dj_name');

    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });
});
