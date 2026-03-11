import { requirePermissions } from "@wxyc/authentication";
import { Router } from "express";
import * as labelsController from "../controllers/labels.controller.js";

export const labels_route = Router();

labels_route.get(
  "/",
  requirePermissions({ catalog: ["read"] }),
  labelsController.getLabels
);

labels_route.get(
  "/info",
  requirePermissions({ catalog: ["read"] }),
  labelsController.getLabel
);

labels_route.get(
  "/search",
  requirePermissions({ catalog: ["read"] }),
  labelsController.searchLabelsEndpoint
);

labels_route.post(
  "/",
  requirePermissions({ catalog: ["write"] }),
  labelsController.createLabel
);
