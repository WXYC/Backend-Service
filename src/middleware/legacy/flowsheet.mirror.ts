import { QueryParams } from "@/controllers/flowsheet.controller.js";
import { createBackendMirrorMiddleware } from "./utilities.js";

const getEntries = createBackendMirrorMiddleware((req) => {
  const query = req.query as QueryParams;

  const page = parseInt(query.page ?? "0");
  const limit = parseInt(query.limit ?? "30");
  const offset = page * limit;

  return "SELECT * FROM FLOWSHEET_ENTRY LIMIT 10;";
});

export const flowsheetMirror = {
  getEntries,
};
