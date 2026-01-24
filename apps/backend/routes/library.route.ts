import { requirePermissions } from "@wxyc/authentication";
import { Router } from "express";
import * as libraryController from "../controllers/library.controller.js";
import { Roles } from "../middleware/cognito.auth.js";

const { dj, musicDirector, stationMgr } = Roles;

export const library_route = Router();

library_route.get(
  "/",
  requirePermissions({ catalog: ["read"] }),
  libraryController.searchForAlbum
);

library_route.post(
  "/",
  requirePermissions({ catalog: ["write"] }),
  libraryController.addAlbum
);

library_route.get(
  "/rotation",
  requirePermissions({ catalog: ["read"] }),
  libraryController.getRotation
);

library_route.post(
  "/rotation",
  requirePermissions({ catalog: ["write"] }),
  libraryController.addRotation
);

library_route.patch(
  "/rotation",
  requirePermissions({ catalog: ["write"] }),
  libraryController.killRotation
);

library_route.post(
  "/artists",
  requirePermissions({ catalog: ["write"] }),
  libraryController.addArtist
);

library_route.get(
  "/formats",
  requirePermissions({ catalog: ["read"] }),
  libraryController.getFormats
);

library_route.post(
  "/formats",
  requirePermissions({ catalog: ["write"] }),
  libraryController.addFormat
);

library_route.get(
  "/genres",
  requirePermissions({ catalog: ["read"] }),
  libraryController.getGenres
);

library_route.post(
  "/genres",
  requirePermissions({ catalog: ["write"] }),
  libraryController.addGenre
);

library_route.get(
  "/info",
  requirePermissions({ catalog: ["read"] }),
  libraryController.getAlbum
);

library_route.get(
  "/tracks/search",
  requirePermissions({ catalog: ["read"] }),
  libraryController.searchTracks
);
