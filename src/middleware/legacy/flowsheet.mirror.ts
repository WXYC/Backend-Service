import { QueryParams } from "@/controllers/flowsheet.controller.js";
import { db } from "@/db/drizzle_client.js";
import { djs, flowsheet, FSEntry, Show } from "@/db/schema.js";
import { asc, desc, eq } from "drizzle-orm";
import { Request } from "express";
import { createBackendMirrorMiddleware } from "./mirror.middleware.js";
import { safeSql, safeSqlNum, toMs } from "./utilities.mirror.js";

const FLOWSHEET_ENTRY_TABLE = "FLOWSHEET_ENTRY_PROD";
const RADIO_SHOW_TABLE = "FLOWSHEET_RADIO_SHOW_PROD";

const getEntries = createBackendMirrorMiddleware<any>(async (req, data) => {
  const query = req.query as QueryParams;

  const page = parseInt(query.page ?? "0");
  const limit = parseInt(query.limit ?? "30");
  const offset = page * limit;

  return [
    `SELECT * FROM ${FLOWSHEET_ENTRY_TABLE} LIMIT ${limit} OFFSET ${offset};`,
  ];
});

const startShow = createBackendMirrorMiddleware<Show>(async (req, show) => {
  const nowMs = Date.now();
  const statements: string[] = [];

  const startMs = toMs(show.start_time ?? req.body?.start_time ?? nowMs);
  const djId = Number.isFinite(Number(show.primary_dj_id ?? req.body?.dj_id))
    ? Number(show.primary_dj_id ?? req.body?.dj_id)
    : null;

  if (!djId) return statements; // no DJ, nothing to do
  if (!show) return statements; // no show, nothing to do

  const dj = (
    await db.select().from(djs).where(eq(djs.id, djId)).limit(1)
  )?.[0];

  if (!dj) return statements; // DJ not found

  const showName = show.show_name ?? req.body?.show_name ?? '';
  const specialtyId = Number.isFinite(Number(show.specialty_id ?? req.body?.specialty_id))
    ? Number(show.specialty_id ?? req.body?.specialty_id)
    : 0;
  const startingHour = Math.floor(startMs / 3_600_000) * 3_600_000;
  const workingHour = startingHour; // Initially same as starting hour, updates as show progresses
  const timeCreated = startMs;
  const timeModified = startMs;

  // NOTE: Legacy table has no AUTO_INCREMENT; we allocate ID as MAX(ID)+1.
  statements.push(
    `SET @NEW_RS_ID := (SELECT IFNULL(MAX(ID), 0) + 1 FROM ${RADIO_SHOW_TABLE});`,
    `INSERT INTO ${RADIO_SHOW_TABLE}
        (ID, STARTING_RADIO_HOUR, DJ_NAME, DJ_ID, DJ_HANDLE, SHOW_NAME, SPECIALTY_SHOW_ID,
         WORKING_HOUR, SIGNON_TIME, SIGNOFF_TIME, TIME_LAST_MODIFIED, TIME_CREATED, MODLOCK, SHOW_ID)
       VALUES
        (@NEW_RS_ID,
         ${safeSqlNum(startingHour)},         -- STARTING_RADIO_HOUR (hour bucket)
         ${safeSql(dj.real_name)},            -- DJ_NAME (real name)
         0,                                   -- DJ_ID (always 0 in legacy system)
         ${safeSql(dj.dj_name)},              -- DJ_HANDLE (DJ name/handle)
         ${safeSql(showName)},                -- SHOW_NAME
         ${safeSqlNum(specialtyId)},          -- SPECIALTY_SHOW_ID (0 if not specialty)
         ${safeSqlNum(workingHour)},          -- WORKING_HOUR (current working hour bucket)
         ${safeSqlNum(startMs)},              -- SIGNON_TIME (actual sign-on timestamp)
         0,                                   -- SIGNOFF_TIME (0 for active shows, set to timestamp on end)
         ${safeSqlNum(timeModified)},         -- TIME_LAST_MODIFIED
         ${safeSqlNum(timeCreated)},          -- TIME_CREATED
         0,                                   -- MODLOCK (0 for active, 1 when completed)
         @NEW_RS_ID);`                        // SHOW_ID (same as ID)
  );

  var announcementEntry = await db
    .select()
    .from(flowsheet)
    .where(eq(flowsheet.show_id, show.id))
    .orderBy(desc(flowsheet.play_order))
    .limit(1);

  if (announcementEntry && announcementEntry.length > 0) {
    statements.push(...(await getAddEntrySQL(req, announcementEntry[0])));
  }

  return statements;
});

export const endShow = createBackendMirrorMiddleware<Show>(
  async (req, show) => {
    const endMs = toMs(show.end_time ?? Date.now());
    const statements: string[] = [];

    // Update the most recent active show (SIGNOFF_TIME = 0, MODLOCK = 0)
    statements.push(
      `UPDATE ${RADIO_SHOW_TABLE}
       SET SIGNOFF_TIME = ${safeSqlNum(endMs)},
           TIME_LAST_MODIFIED = ${safeSqlNum(endMs)},
           MODLOCK = 1
     WHERE SIGNOFF_TIME = 0
       AND MODLOCK = 0
     ORDER BY STARTING_RADIO_HOUR DESC
     LIMIT 1;`
    );

    var announcementEntry = await db
      .select()
      .from(flowsheet)
      .where(eq(flowsheet.show_id, show.id))
      .orderBy(desc(flowsheet.play_order))
      .limit(1);

    if (announcementEntry && announcementEntry.length > 0) {
      statements.push(...(await getAddEntrySQL(req, announcementEntry[0])));
    }

    return statements;
  }
);

const getAddEntrySQL = async (req: Request, entry: FSEntry) => {
  const startMs = entry?.add_time
    ? new Date(entry.add_time).getTime()
    : Date.now();
  const radioHour = Math.floor(startMs / 3_600_000) * 3_600_000;

  const statements: string[] = [];

  // 1) Resolve legacy RADIO_SHOW_ID for the active modern show
  statements.push(
    `SET @RS_ID := (SELECT IFNULL(MAX(ID), 0) FROM ${RADIO_SHOW_TABLE});`,

    // 2) Get next sequence number within the show
    `SET @SEQ_NUM := (SELECT IFNULL(MAX(SEQUENCE_WITHIN_SHOW), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE} WHERE RADIO_SHOW_ID = @RS_ID);`,

    // 3) Allocate new legacy entry ID
    `SET @NEW_FE_ID := (SELECT IFNULL(MAX(ID), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE});`,

    // 4) Update WORKING_HOUR in radio show if we're in a new hour bucket
    `UPDATE ${RADIO_SHOW_TABLE}
        SET WORKING_HOUR = ${safeSqlNum(radioHour)},
            TIME_LAST_MODIFIED = ${safeSqlNum(startMs)}
      WHERE ID = @RS_ID
        AND WORKING_HOUR < ${safeSqlNum(radioHour)};`,

    // 5) Close prior "now playing" (if any) for this show
    `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET NOW_PLAYING_FLAG = 0,
            STOP_TIME = ${safeSqlNum(startMs)},
            TIME_LAST_MODIFIED = ${safeSqlNum(startMs)}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND NOW_PLAYING_FLAG = 1
        AND STOP_TIME = 0;`
  );

  if (entry?.message && entry.message.trim() !== "") {
    let message = entry.message.trim();
    let entryTypeCode = 7; // Default to talkset
    let nowPlayingFlag = 0;
    let startTime = 0;
    
    // Detect the type of message entry
    if (message.toLowerCase().includes("breakpoint")) {
      entryTypeCode = 8; // Breakpoint
      message = message.toUpperCase();
    } else if (message.toLowerCase().includes("start of show") || message.toLowerCase().includes("signed on")) {
      entryTypeCode = 9; // Start of show
      startTime = startMs;
    } else if (message.toLowerCase().includes("end of show") || message.toLowerCase().includes("signed off")) {
      entryTypeCode = 10; // End of show
      startTime = startMs;
    } else {
      // Talkset - format as "------ talkset -------"
      message = "------ talkset -------";
    }

    statements.push(
      `INSERT INTO ${FLOWSHEET_ENTRY_TABLE}
      (ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
       LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME, STOP_TIME,
       RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG, FLOWSHEET_ENTRY_TYPE_CODE_ID,
       TIME_LAST_MODIFIED, TIME_CREATED, REQUEST_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER)
     VALUES
      (@NEW_FE_ID,
       ${safeSql(message)},                   -- ARTIST_NAME
       0,                                     -- ARTIST_ID
       '',                                    -- SONG_TITLE
       '',                                    -- RELEASE_TITLE
       0,                                     -- RELEASE_FORMAT_ID
       0,                                     -- LIBRARY_RELEASE_ID
       0,                                     -- ROTATION_RELEASE_ID
       '',                                    -- LABEL_NAME
       ${safeSqlNum(radioHour)},              -- RADIO_HOUR (hour bucket)
       ${safeSqlNum(startTime)},              -- START_TIME (0 for talksets/breakpoints, actual time for start/end)
       0,                                     -- STOP_TIME
       @RS_ID,                                -- RADIO_SHOW_ID (legacy)
       @SEQ_NUM,                              -- SEQUENCE_WITHIN_SHOW
       ${nowPlayingFlag},                     -- NOW_PLAYING_FLAG (0 for announcements)
       ${entryTypeCode},                      -- FLOWSHEET_ENTRY_TYPE_CODE_ID (7=talkset, 8=breakpoint, 9=start, 10=end)
       ${safeSqlNum(startMs)},                -- TIME_LAST_MODIFIED
       ${safeSqlNum(startMs)},                -- TIME_CREATED
       0,                                     -- REQUEST_FLAG
       (@RS_ID * 1000 + @SEQ_NUM),            -- GLOBAL_ORDER_ID (RADIO_SHOW_ID * 1000 + SEQUENCE)
       '');` // BMI_COMPOSER
    );
  } else {
    // Determine entry type code based on rotation and library IDs
    // Type codes: 1-4 for different rotation types, 6 for library, 0 for manual/unknown
    let entryTypeCode = 0;
    if (entry.rotation_id && entry.rotation_id > 0) {
      // Rotation entries - default to type 2 (general rotation)
      // Would need rotation type lookup for accurate 1-4 classification
      entryTypeCode = 2;
    } else if (entry.album_id && entry.album_id > 0) {
      entryTypeCode = 6; // Library entry
    }
    
    statements.push(
      `INSERT INTO ${FLOWSHEET_ENTRY_TABLE}
      (ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
       LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME, STOP_TIME,
       RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG, FLOWSHEET_ENTRY_TYPE_CODE_ID,
       TIME_LAST_MODIFIED, TIME_CREATED, REQUEST_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER)
     VALUES
      (@NEW_FE_ID,
       ${safeSql(entry.artist_name)},             -- ARTIST_NAME
       0,                                         -- ARTIST_ID
       ${safeSql(entry.track_title)},             -- SONG_TITLE
       ${safeSql(entry.album_title)},             -- RELEASE_TITLE
       0,                                         -- RELEASE_FORMAT_ID
       ${safeSqlNum(entry.album_id)},             -- LIBRARY_RELEASE_ID
       ${safeSqlNum(entry.rotation_id)},          -- ROTATION_RELEASE_ID
       ${safeSql(entry.record_label)},            -- LABEL_NAME
       ${safeSqlNum(radioHour)},                  -- RADIO_HOUR (hour bucket)
       0,                                         -- START_TIME (0 for regular songs)
       0,                                         -- STOP_TIME
       @RS_ID,                                    -- RADIO_SHOW_ID (legacy)
       @SEQ_NUM,                                  -- SEQUENCE_WITHIN_SHOW
       1,                                         -- NOW_PLAYING_FLAG (set to 1 for new entries)
       ${entryTypeCode},                          -- FLOWSHEET_ENTRY_TYPE_CODE_ID
       ${safeSqlNum(startMs)},                    -- TIME_LAST_MODIFIED
       ${safeSqlNum(startMs)},                    -- TIME_CREATED
       ${safeSqlNum(entry.request_flag ? 1 : 0)}, -- REQUEST_FLAG (bool --> int)
       (@RS_ID * 1000 + @SEQ_NUM),                -- GLOBAL_ORDER_ID (RADIO_SHOW_ID * 1000 + SEQUENCE)
       '');` // BMI_COMPOSER
    );
  }

  return statements;
};

export const addEntry = createBackendMirrorMiddleware<FSEntry>(getAddEntrySQL);

export const updateEntry = createBackendMirrorMiddleware<FSEntry>(
  async (req, entry) => {
    // Message-only rows aren't updateable
    if (entry?.message && entry.message.trim() !== "") return [];

    const nowMs = Date.now();
    const statements: string[] = [];

    // Resolve the RADIO_SHOW_ID first
    statements.push(
      `SET @RS_ID := (SELECT IFNULL(MAX(ID), 0) FROM ${RADIO_SHOW_TABLE});`
    );

    // Determine entry type code based on rotation and library IDs
    // Type codes: 1-4 for different rotation types, 6 for library, 0 for manual/unknown
    let entryTypeCode = 0;
    if (entry.rotation_id && entry.rotation_id > 0) {
      // Rotation entries - default to type 2 (general rotation)
      // Would need rotation type lookup for accurate 1-4 classification
      entryTypeCode = 2;
    } else if (entry.album_id && entry.album_id > 0) {
      entryTypeCode = 6; // Library entry
    }

    // Update by RADIO_SHOW_ID and SEQUENCE_WITHIN_SHOW
    // GLOBAL_ORDER_ID is calculated as RADIO_SHOW_ID * 1000 + SEQUENCE_WITHIN_SHOW
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET ARTIST_NAME = ${safeSql(entry.artist_name)},
            SONG_TITLE = ${safeSql(entry.track_title)},
            RELEASE_TITLE = ${safeSql(entry.album_title)},
            LABEL_NAME = ${safeSql(entry.record_label)},
            LIBRARY_RELEASE_ID = ${safeSqlNum(entry.album_id)},
            ROTATION_RELEASE_ID = ${safeSqlNum(entry.rotation_id)},
            REQUEST_FLAG = ${safeSqlNum(entry.request_flag ? 1 : 0)},
            FLOWSHEET_ENTRY_TYPE_CODE_ID = ${entryTypeCode},
            TIME_LAST_MODIFIED = ${safeSqlNum(nowMs)}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND SEQUENCE_WITHIN_SHOW = ${safeSqlNum(entry.play_order)}
      LIMIT 1;`
    );

    return statements;
  }
);

export const deleteEntry = createBackendMirrorMiddleware<FSEntry>(
  async (req, removed) => {
    const statements: string[] = [];

    // Resolve the RADIO_SHOW_ID first
    statements.push(
      `SET @RS_ID := (SELECT IFNULL(MAX(ID), 0) FROM ${RADIO_SHOW_TABLE});`
    );

    // Delete by RADIO_SHOW_ID and SEQUENCE_WITHIN_SHOW
    statements.push(
      `DELETE FROM ${FLOWSHEET_ENTRY_TABLE}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND SEQUENCE_WITHIN_SHOW = ${safeSqlNum(removed.play_order)}
      LIMIT 1;`
    );

    return statements;
  }
);

/*
export const changeOrder = createBackendMirrorMiddleware<FSEntry>(
  async (req, moved) => {
    const entryId = Number((req.body ?? {}).entry_id);
    const newPos = Number((req.body ?? {}).new_position);

    if (!entryId || !newPos) return []; // hard guard; controller already validated

    const statements: string[] = [];

    // 1) Resolve this legacy show row
    statements.push(
      `SET @RS_ID := (SELECT ID FROM ${RADIO_SHOW_TABLE}
                     WHERE SHOW_ID = ${safeSqlNum(moved.show_id)}
                     ORDER BY TIME_CREATED DESC LIMIT 1);`
    );

    // 2) Locate the legacy entry for the moved row via GLOBAL_ORDER_ID
    statements.push(
      `SET @E_ID := (SELECT ID FROM ${FLOWSHEET_ENTRY_TABLE}
                    WHERE GLOBAL_ORDER_ID = ${safeSqlNum(entryId)}
                      AND RADIO_SHOW_ID = @RS_ID
                    LIMIT 1);`
    );

    // Optional: fallback if GLOBAL_ORDER_ID wasn’t set (rare once add-entry is updated)
    statements.push(
      `SET @E_ID := IFNULL(@E_ID, (SELECT ID FROM ${FLOWSHEET_ENTRY_TABLE}
                                  WHERE RADIO_SHOW_ID = @RS_ID
                                  ORDER BY SEQUENCE_WITHIN_SHOW DESC LIMIT 1));`
    );

    // 3) Read old position
    statements.push(
      `SET @OLD_POS := (SELECT SEQUENCE_WITHIN_SHOW FROM ${FLOWSHEET_ENTRY_TABLE}
                       WHERE ID = @E_ID LIMIT 1);`,
      `SET @NEW_POS := ${safeSqlNum(newPos)};`
    );

    // 4) Shift neighbors, then place the moved entry
    // Move upward: new position is smaller number
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET SEQUENCE_WITHIN_SHOW = SEQUENCE_WITHIN_SHOW + 1
      WHERE RADIO_SHOW_ID = @RS_ID
        AND @NEW_POS < @OLD_POS
        AND SEQUENCE_WITHIN_SHOW >= @NEW_POS
        AND SEQUENCE_WITHIN_SHOW <  @OLD_POS;`
    );
    // Move downward: new position is larger number
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET SEQUENCE_WITHIN_SHOW = SEQUENCE_WITHIN_SHOW - 1
      WHERE RADIO_SHOW_ID = @RS_ID
        AND @NEW_POS > @OLD_POS
        AND SEQUENCE_WITHIN_SHOW >  @OLD_POS
        AND SEQUENCE_WITHIN_SHOW <= @NEW_POS;`
    );
    // Place moved entry
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET SEQUENCE_WITHIN_SHOW = @NEW_POS,
            TIME_LAST_MODIFIED = ${safeSqlNum(Date.now())}
      WHERE ID = @E_ID
      LIMIT 1;`
    );

    return statements;
  }
);
*/

export const flowsheetMirror = {
  getEntries,
  startShow,
  endShow,
  addEntry,
  updateEntry,
  deleteEntry,
  /*changeOrder,*/
};
