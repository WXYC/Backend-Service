import { QueryParams } from "../../controllers/flowsheet.controller.js";
import { db } from "@wxyc/database";
import { djs, flowsheet, FSEntry, Show } from "@wxyc/database/schema";
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

  const showName = show.show_name ?? req.body?.show_name ?? null;
  const specialtyId = Number(
    show.specialty_id ?? req.body?.specialty_id ?? null
  );
  const startingHour = Math.floor(startMs / 3_600_000) * 3_600_000;
  const workingHour = startingHour;
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
         ${safeSqlNum(startingHour)},
         ${safeSql(dj.real_name)},
         ${safeSqlNum(djId)},
         ${safeSql(dj.dj_name)},    
         ${safeSql(showName)},
         ${safeSqlNum(specialtyId)},
         ${safeSqlNum(workingHour)},
         ${safeSqlNum(startMs)},
         NULL,                             -- SIGNOFF_TIME set on end-show mirror
         ${safeSqlNum(timeModified)},
         ${safeSqlNum(timeCreated)},
         0,                                -- MODLOCK default to 0 (unlocked)
         @NEW_RS_ID);`
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

    statements.push(
      `UPDATE ${RADIO_SHOW_TABLE}
       SET SIGNOFF_TIME = ${safeSqlNum(endMs)},
           TIME_LAST_MODIFIED = ${safeSqlNum(endMs)},
              MODLOCK = 1
     WHERE SIGNOFF_TIME IS NULL
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

    // 3) Allocate new legacy entry ID
    `SET @NEW_FE_ID := (SELECT IFNULL(MAX(ID), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE});`,

    // 4) Close prior "now playing" (if any) for this show
    `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET NOW_PLAYING_FLAG = 0,
            STOP_TIME = ${safeSqlNum(startMs)},
            TIME_LAST_MODIFIED = ${safeSqlNum(startMs)}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND NOW_PLAYING_FLAG = 1
        AND STOP_TIME IS NULL;`
  );

  if (entry?.message && entry.message.trim() !== "") {
    let message = `-- ${entry.message.trim().toUpperCase()} --`;

    statements.push(
      `INSERT INTO ${FLOWSHEET_ENTRY_TABLE}
      (ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
       LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME, STOP_TIME,
       RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG, FLOWSHEET_ENTRY_TYPE_CODE_ID,
       TIME_LAST_MODIFIED, TIME_CREATED, REQUEST_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER)
     VALUES
      (@NEW_FE_ID,
       ${safeSql(message)},         -- ARTIST_NAME
       0,                                     -- ARTIST_ID (unknown)
       '',                                    -- SONG_TITLE
       '',                                    -- RELEASE_TITLE
       0,                                     -- RELEASE_FORMAT_ID (unknown here)
       0,                                     -- LIBRARY_RELEASE_ID
       0,                                     -- ROTATION_RELEASE_ID
       '',                                    -- LABEL_NAME
       ${safeSqlNum(radioHour)},              -- RADIO_HOUR (hour bucket)
       ${safeSqlNum(startMs)},                -- START_TIME
       NULL,                                  -- STOP_TIME (filled when next track starts)
       @RS_ID,                                -- RADIO_SHOW_ID (legacy)
       ${safeSqlNum(entry.id)},               -- SEQUENCE_WITHIN_SHOW
       1,                                     -- NOW_PLAYING_FLAG
       0,                                     -- FLOWSHEET_ENTRY_TYPE_CODE_ID (unknown --> 0)
       ${safeSqlNum(startMs)},                -- TIME_LAST_MODIFIED
       ${safeSqlNum(startMs)},                -- TIME_CREATED
       0,                                     -- REQUEST_FLAG (bool --> int)
       ${safeSqlNum(entry.id)},               -- GLOBAL_ORDER_ID
       '');` // BMI_COMPOSER
    );
  } else {
    statements.push(
      `INSERT INTO ${FLOWSHEET_ENTRY_TABLE}
      (ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
       LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME, STOP_TIME,
       RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG, FLOWSHEET_ENTRY_TYPE_CODE_ID,
       TIME_LAST_MODIFIED, TIME_CREATED, REQUEST_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER)
     VALUES
      (@NEW_FE_ID,
       ${safeSql(entry.artist_name)},             -- ARTIST_NAME
       0,                                         -- ARTIST_ID (unknown)
       ${safeSql(entry.track_title)},             -- SONG_TITLE
       ${safeSql(entry.album_title)},             -- RELEASE_TITLE
       0,                                         -- RELEASE_FORMAT_ID (unknown here)
       ${safeSqlNum(entry.album_id)},             -- LIBRARY_RELEASE_ID
       ${safeSqlNum(entry.rotation_id)},          -- ROTATION_RELEASE_ID
       ${safeSql(entry.record_label)},            -- LABEL_NAME
       ${safeSqlNum(radioHour)},                  -- RADIO_HOUR (hour bucket)
       ${safeSqlNum(startMs)},                    -- START_TIME
       NULL,                                      -- STOP_TIME (filled when next track starts)
       @RS_ID,                                    -- RADIO_SHOW_ID (legacy)
       ${safeSqlNum(entry.id)},                   -- SEQUENCE_WITHIN_SHOW
       1,                                         -- NOW_PLAYING_FLAG
       0,                                         -- FLOWSHEET_ENTRY_TYPE_CODE_ID (unknown --> NULL)
       ${safeSqlNum(startMs)},                    -- TIME_LAST_MODIFIED
       ${safeSqlNum(startMs)},                    -- TIME_CREATED
       ${safeSqlNum(entry.request_flag ? 1 : 0)}, -- REQUEST_FLAG (bool --> int)
       ${safeSqlNum(entry.id)},                   -- GLOBAL_ORDER_ID
       '');` // BMI_COMPOSER
    );
  }

  return statements;
};

export const addEntry = createBackendMirrorMiddleware<FSEntry>(getAddEntrySQL);

export const updateEntry = createBackendMirrorMiddleware<FSEntry>(
  async (req, entry) => {
    // Message-only rows aren’t updateable
    if (entry?.message && entry.message.trim() !== "") return [];

    const nowMs = Date.now();
    const statements: string[] = [];

    // Update by preferred mapping (GLOBAL_ORDER_ID = modern entry.id),
    // or fallback to match by (show, sequence) if GLOBAL_ORDER_ID isn’t set.
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET ARTIST_NAME = ${safeSql(entry.artist_name)},
            SONG_TITLE = ${safeSql(entry.track_title)},
            RELEASE_TITLE = ${safeSql(entry.album_title)},
            LABEL_NAME = ${safeSql(entry.record_label)},
            LIBRARY_RELEASE_ID = ${safeSqlNum(entry.album_id)},
            ROTATION_RELEASE_ID = ${safeSqlNum(entry.rotation_id)},
            REQUEST_FLAG = ${safeSqlNum(entry.request_flag ? 1 : 0)},
            TIME_LAST_MODIFIED = ${safeSqlNum(nowMs)}
      WHERE (GLOBAL_ORDER_ID = ${safeSqlNum(entry.id)}
             AND SEQUENCE_WITHIN_SHOW = ${safeSqlNum(entry.play_order)})
      LIMIT 1;`
    );

    return statements;
  }
);

export const deleteEntry = createBackendMirrorMiddleware<FSEntry>(
  async (req, removed) => {
    // Message-only rows weren’t mirrored, so nothing to do
    if (removed?.message && removed.message.trim() !== "") return [];

    const statements: string[] = [];

    statements.push(
      `DELETE FROM ${FLOWSHEET_ENTRY_TABLE}
      WHERE (GLOBAL_ORDER_ID = ${safeSqlNum(removed.id)}
             AND SEQUENCE_WITHIN_SHOW = ${safeSqlNum(removed.play_order)})
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
