import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import * as labelsController from '../controllers/labels.controller.js';

export const labels_route = Router();

labels_route.get('/', requirePermissions({ catalog: ['read'] }), labelsController.getLabels);

labels_route.get('/info', requirePermissions({ catalog: ['read'] }), labelsController.getLabel);

labels_route.get('/search', requirePermissions({ catalog: ['read'] }), labelsController.searchLabelsEndpoint);

labels_route.post('/', requirePermissions({ catalog: ['write'] }), labelsController.createLabel);

labels_route.get('/:id', requirePermissions({ catalog: ['read'] }), labelsController.getLabelWithReferences);

labels_route.patch('/:id', requirePermissions({ catalog: ['write'] }), labelsController.updateLabel);

labels_route.delete('/:id', requirePermissions({ catalog: ['write'] }), labelsController.deleteLabel);
