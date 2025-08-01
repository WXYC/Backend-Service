import { proxy } from "./proxy.js";
import { requestFromOldBackend } from "./request.js";

export const flowsheetMirror = {
  getEntries:  proxy(() => null, requestFromOldBackend('GET', '/flowsheet')),
};