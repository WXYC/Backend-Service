import { requirePermissions } from "@wxyc/authentication";
import { Router } from "express";
import * as flowsheetV2Controller from "../controllers/flowsheet.v2.controller.js";
import { flowsheetMirror } from "../middleware/legacy/flowsheet.mirror.js";
import { conditionalGet } from "../middleware/conditionalGet.js";

export const flowsheet_v2_route = Router();

// Read operations
flowsheet_v2_route.get(
  "/",
  conditionalGet,
  flowsheetV2Controller.getEntries
);

flowsheet_v2_route.get(
  "/latest",
  conditionalGet,
  flowsheetV2Controller.getLatest
);

flowsheet_v2_route.get("/on-air", flowsheetV2Controller.getOnAir);

flowsheet_v2_route.get("/djs-on-air", flowsheetV2Controller.getDJList);

flowsheet_v2_route.get("/playlist", flowsheetV2Controller.getShowInfo);

// Write operations - separated by entry type
flowsheet_v2_route.post(
  "/track",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.addEntry,
  flowsheetV2Controller.addTrack
);

flowsheet_v2_route.post(
  "/talkset",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.addEntry,
  flowsheetV2Controller.addTalkset
);

flowsheet_v2_route.post(
  "/breakpoint",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.addEntry,
  flowsheetV2Controller.addBreakpoint
);

flowsheet_v2_route.post(
  "/message",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.addEntry,
  flowsheetV2Controller.addMessage
);

// Entry modification
flowsheet_v2_route.patch(
  "/:id",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.updateEntry,
  flowsheetV2Controller.updateEntry
);

flowsheet_v2_route.delete(
  "/:id",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.deleteEntry,
  flowsheetV2Controller.deleteEntry
);

flowsheet_v2_route.patch(
  "/play-order",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetV2Controller.changeOrder
);

// Show management
flowsheet_v2_route.post(
  "/join",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.startShow,
  flowsheetV2Controller.joinShow
);

flowsheet_v2_route.post(
  "/end",
  requirePermissions({ flowsheet: ["write"] }),
  flowsheetMirror.endShow,
  flowsheetV2Controller.leaveShow
);
