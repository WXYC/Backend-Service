/**
 * Backfill orchestrator for B-2.2.
 *
 * STUB — implementation lands in the next commit. Exports the symbols the
 * tests bind to so failures are behavioral, not import errors.
 */

import type { LmlLookupResponse } from './lml-types.js';

export const BATCH_SIZE = 500;
export const THROTTLE_MS = 100;

export type FlowsheetRow = {
  id: number;
  artist_name: string | null;
  album_title: string | null;
};

export type LookupFn = (artist: string, album?: string) => Promise<LmlLookupResponse>;

export type ProcessStatus = 'linked' | 'multi_match' | 'no_library_match' | 'review' | 'no_match' | 'error';

export type Totals = {
  scanned: number;
  linked: number;
  multi_match: number;
  no_library_match: number;
  review: number;
  no_match: number;
  error: number;
};

export type RunResult = { totals: Totals };

export const applyLink = async (_args: {
  flowsheetId: number;
  libraryId: number;
  confidence: number;
}): Promise<void> => {
  throw new Error('applyLink not implemented yet');
};

export const findLibraryByCanonicalEntity = async (_canonicalEntityId: string): Promise<number[]> => {
  throw new Error('findLibraryByCanonicalEntity not implemented yet');
};

export const processRow = async (
  _row: FlowsheetRow,
  _deps: { lookup: LookupFn }
): Promise<ProcessStatus> => {
  throw new Error('processRow not implemented yet');
};

export const runBackfill = async (_opts: {
  lookup: LookupFn;
  batchSize?: number;
  throttleMs?: number;
}): Promise<RunResult> => {
  throw new Error('runBackfill not implemented yet');
};
