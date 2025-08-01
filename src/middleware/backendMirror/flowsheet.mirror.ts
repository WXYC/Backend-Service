import { proxy } from "./proxy.js";
import { requestFromOldBackend } from "./timsBackend.js";

export const flowsheetMirror = {
  getEntries:  proxy(() => null,      requestFromOldBackend('GET',    '/flowsheet')),
};