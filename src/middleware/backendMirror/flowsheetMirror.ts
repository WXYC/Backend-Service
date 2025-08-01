import { proxy } from "./proxy.js";
import { requestFromOldBackend } from "./timsBackend.js";

export const flowsheetMirror = {
  getEntries:  proxy(() => null,      requestFromOldBackend('GET',    '/flowsheet')),
  addEntry:    proxy((b) => b,        requestFromOldBackend('POST',   '/flowsheet')),
  updateEntry: proxy((b) => b,        requestFromOldBackend('PATCH',  '/flowsheet')),
  deleteEntry: proxy((b) => b,        requestFromOldBackend('DELETE', '/flowsheet')),
  getLatest:   proxy(() => null,      requestFromOldBackend('GET',    '/flowsheet/latest')),
  joinShow:    proxy((b) => b,        requestFromOldBackend('POST',   '/flowsheet/join')),
  leaveShow:   proxy((b) => b,        requestFromOldBackend('POST',   '/flowsheet/end')),
  getDJList:   proxy(() => null,      requestFromOldBackend('GET',    '/flowsheet/djs-on-air')),
  getOnAir:    proxy(() => null,      requestFromOldBackend('GET',    '/flowsheet/on-air')),
  changeOrder: proxy((b) => b,        requestFromOldBackend('PATCH',  '/flowsheet/play-order')),
  getPlaylist: proxy(() => null,      requestFromOldBackend('GET',    '/flowsheet/playlist')),
};