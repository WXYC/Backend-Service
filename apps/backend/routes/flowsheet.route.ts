import { flowsheetMirror } from "../middleware/legacy/flowsheet.mirror.js";
import { Router } from "express";
import * as flowsheetController from "../controllers/flowsheet.controller.js";
import { authMiddleware, requireDJ } from "@wxyc/auth-middleware";

export const flowsheet_route = Router();

flowsheet_route.get(
  "/",
  flowsheetMirror.getEntries,
  flowsheetController.getEntries
);

flowsheet_route.post(
  "/",
  authMiddleware(),
  requireDJ,
  flowsheetMirror.addEntry,
  flowsheetController.addEntry
);

flowsheet_route.patch(
  "/",
  authMiddleware(),
  requireDJ,
  flowsheetMirror.updateEntry,
  flowsheetController.updateEntry
);

flowsheet_route.delete(
  "/",
  authMiddleware(),
  requireDJ,
  flowsheetMirror.deleteEntry,
  flowsheetController.deleteEntry
);

flowsheet_route.patch(
  "/play-order",
  authMiddleware(),
  requireDJ,
  /*flowsheetMirror.changeOrder,*/
  flowsheetController.changeOrder
);

flowsheet_route.get("/latest", flowsheetController.getLatest);

flowsheet_route.post(
  "/join",
  authMiddleware(),
  requireDJ,
  flowsheetMirror.startShow,
  flowsheetController.joinShow
);

flowsheet_route.post(
  "/end",
  authMiddleware(),
  requireDJ,
  flowsheetMirror.endShow,
  flowsheetController.leaveShow
);

flowsheet_route.get("/djs-on-air", flowsheetController.getDJList);

flowsheet_route.get("/on-air", flowsheetController.getOnAir);

flowsheet_route.get("/playlist", flowsheetController.getShowInfo);

flowsheet_route.get("/show-info", flowsheetController.getShowInfo);
