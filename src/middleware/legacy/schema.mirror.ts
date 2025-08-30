

import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, index, int, mysqlSchema, varchar } from "drizzle-orm/mysql-core";

export const wxyc_legacy_schema = mysqlSchema(process.env.REMOTE_DB_NAME || "UNDEFINED_DB");

export type NewLegacyFlowsheetEntry = InferInsertModel<typeof legacy_flowsheet_entries>;
export type LegacyFlowsheetEntry = InferSelectModel<typeof legacy_flowsheet_entries>;

export const legacy_flowsheet_entries = 
    wxyc_legacy_schema.table('FLOWSHEET_ENTRY', {
        ID: int().primaryKey().notNull().default(0),
        ARTIST_NAME: varchar({ length: 255 }),
        ARTIST_ID: int(),
        SONG_TITLE: varchar({ length: 255 }),
        RELEASE_TITLE: varchar({ length: 255 }),
        RELEASE_FORMAT_ID: int(),
        LIBRARY_RELEASE_ID: int(),
        ROTATION_RELEASE_ID: int(),
        LABEL_NAME: varchar({ length: 255 }),
        RADIO_HOUR: bigint({ mode: 'bigint' }),
        START_TIME: bigint({ mode: 'bigint' }),
        STOP_TIME: bigint({ mode: 'bigint' }),
        RADIO_SHOW_ID: int(),
        SEQUENCE_WITHIN_SHOW: int(),
        NOW_PLAYING_FLAG: int(),
        FLOWSHEET_ENTRY_TYPE_CODE_ID: int(),
        TIME_LAST_MODIFIED: bigint({ mode: 'bigint' }),
        TIME_CREATED: bigint({ mode: 'bigint' }),
        REQUEST_FLAG: int(),
        GLOBAL_ORDER_ID: bigint({ mode: 'bigint' }),
        BMI_COMPOSER: varchar({ length: 255 }),
    },
    (table) => ([
        index('RADIO_SHOW_ID').on(table.RADIO_SHOW_ID),
    ]));