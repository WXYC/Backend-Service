import { FSEntry } from "@/db/schema.js";
import { convertToLegacy } from "./conversions.mirror.js";
import { createBackendMirrorMiddleware } from "./middleware.mirror.js";
import { legacy_flowsheet_entries } from "./schema.mirror.js";

const getLatest = createBackendMirrorMiddleware<void>((_) => [
  {
    label: "Get Latest Flowsheet Entries",
    method: async (db) => {
      return db.select().from(legacy_flowsheet_entries).orderBy(legacy_flowsheet_entries.RADIO_SHOW_ID).limit(10);
    },
  }
]);

const insertEntry = createBackendMirrorMiddleware<FSEntry>((_, data) => [
  {
    label: "Insert Flowsheet Entry",
    method: async (db) => {
      const legacyEntry = convertToLegacy(data);
      return db.insert(legacy_flowsheet_entries).values(legacyEntry);
    },
  },
]);

export const flowsheetMirror = {
  getLatest,
  insertEntry,
};
