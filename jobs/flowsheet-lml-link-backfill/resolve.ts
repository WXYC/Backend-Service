/**
 * Per-row LML signal resolver for the B-2.2 flowsheet backfill.
 *
 * STUB — implementation lands in the next commit. Exports the shape the test
 * expects so the failing test fails for behavioral reasons, not import errors.
 */

import type { LmlLookupResponse } from './lml-types.js';

export type LmlSignal =
  | { status: 'auto_accept'; canonical_entity_id: string; confidence: number }
  | { status: 'review' }
  | { status: 'no_match' };

export const AUTO_ACCEPT_CONFIDENCE = 0.95;

export const resolveLmlSignal = (_response: LmlLookupResponse): LmlSignal => {
  throw new Error('resolveLmlSignal not implemented yet');
};
