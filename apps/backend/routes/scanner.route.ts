/**
 * Scanner routes for vinyl record image scanning, UPC lookup,
 * and batch processing.
 */

import { requirePermissions } from '@wxyc/authentication';
import { Router } from 'express';
import multer from 'multer';
import * as scannerController from '../controllers/scanner.controller.js';

export const scanner_route = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

scanner_route.post(
  '/',
  requirePermissions({ catalog: ['write'] }),
  upload.array('images', 5),
  scannerController.scanImages
);

scanner_route.post(
  '/batch',
  requirePermissions({ catalog: ['write'] }),
  upload.array('images', 50),
  scannerController.createBatchScan
);

scanner_route.get('/batch', requirePermissions({ catalog: ['read'] }), scannerController.listBatchJobs);

scanner_route.get('/batch/:jobId', requirePermissions({ catalog: ['read'] }), scannerController.getBatchStatus);

scanner_route.post('/upc-lookup', requirePermissions({ catalog: ['read'] }), scannerController.upcLookup);
