import { requirePermissions } from "@wxyc/authentication";
import { Router } from "express";
import * as djsController from "../controllers/djs.controller.js";

export const dj_route = Router();

//TODO: secure - mgmt & individual dj
dj_route.get(
  "/",
  requirePermissions({ member: ["update"] }),
  djsController.getDJInfo
);

dj_route.delete(
  "/",
  requirePermissions({ member: ["delete"] }),
  djsController.deleteDJ
);

dj_route.post(
  "/register",
  requirePermissions({ member: ["create"] }),
  djsController.register
);

//TODO: reintroduce auth here once we leave cognito in the dust
dj_route.patch(
  "/register",
  requirePermissions({ member: ["update"] }),
  djsController.update
);

dj_route.post(
  "/bin",
  requirePermissions({ bin: ["write"] }),
  djsController.addToBin
);

dj_route.delete(
  "/bin",
  requirePermissions({ bin: ["write"] }),
  djsController.deleteFromBin
);

dj_route.get(
  "/bin",
  requirePermissions({ bin: ["read"] }),
  djsController.getBin
);

dj_route.get(
  "/playlists",
  requirePermissions({ flowsheet: ["read"] }),
  djsController.getPlaylistsForDJ
);
