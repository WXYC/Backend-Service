import { requirePermissions } from "@wxyc/authentication";
import { Router } from "express";
import * as libraryController from "../controllers/library.controller.js";
import * as requestLineController from "../controllers/requestLine.controller.js";
import { requireAnonymousAuth } from "../middleware/anonymousAuth.js";

export const library_route = Router();

// Public library search endpoint (for request line feature)
// Uses anonymous auth instead of DJ permissions
library_route.get(
  "/search",
  requireAnonymousAuth,
  requestLineController.searchLibraryEndpoint
);

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
