import { flowsheetMirror } from "@/middleware/legacy/flowsheet.mirror.js";
import { Router } from "express";
import * as flowsheetController from "../controllers/flowsheet.controller.js";
import { cognitoMiddleware, Roles } from "../middleware/cognito.auth.js";

const { dj } = Roles;

export const flowsheet_route = Router();

flowsheet_route.get(
  "/",
  flowsheetMirror.getEntries,
  flowsheetController.getEntries
);

flowsheet_route.post(
  "/",
  cognitoMiddleware(dj),
  flowsheetMirror.addEntry,
  flowsheetController.addEntry
);

flowsheet_route.patch(
  "/",
  cognitoMiddleware(dj),
  flowsheetMirror.updateEntry,
  flowsheetController.updateEntry
);

flowsheet_route.delete(
  "/",
  cognitoMiddleware(dj),
  flowsheetMirror.deleteEntry,
  flowsheetController.deleteEntry
);

flowsheet_route.patch(
  "/play-order",
  cognitoMiddleware(dj),
  /*flowsheetMirror.changeOrder,*/
  flowsheetController.changeOrder
);

flowsheet_route.get("/latest", flowsheetController.getLatest);

flowsheet_route.post(
  "/join",
  cognitoMiddleware(dj),
  flowsheetMirror.startShow,
  flowsheetController.joinShow
);

flowsheet_route.post(
  "/end",
  cognitoMiddleware(dj),
  flowsheetMirror.endShow,
  flowsheetController.leaveShow
);

flowsheet_route.get("/djs-on-air", flowsheetController.getDJList);

flowsheet_route.get("/on-air", flowsheetController.getOnAir);

flowsheet_route.get("/playlist", flowsheetController.getShowInfo);

flowsheet_route.get("/show-info", flowsheetController.getShowInfo);
