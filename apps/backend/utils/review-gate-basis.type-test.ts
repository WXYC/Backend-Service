/**
 * Compile-time pins for which gate basis each writer accepts (BS#2810). Never imported and never run: it lives under
 * `apps/backend` because `npm run typecheck` covers that tree and not `tests/**` (ts-jest is transpile-only there), so
 * a `@ts-expect-error` below fails the typecheck the moment its refusal is removed.
 */
import type { insertAlbum, addToRotation } from '../services/library.service.js';
import type { fileLibraryRelease } from '../services/library-filing.service.js';

type InsertAlbumBasis = Parameters<typeof insertAlbum>[1];
type AddToRotationBasis = Parameters<typeof addToRotation>[1];
type FileLibraryReleaseBasis = Parameters<typeof fileLibraryRelease>[1];

export const accepted = [
  { kind: 'legacy_import', rotationId: 1 } satisfies InsertAlbumBasis,
  { kind: 'legacy_move', fromRotationId: 1 } satisfies AddToRotationBasis,
  { kind: 'pre_cutover' } satisfies FileLibraryReleaseBasis,
];

// @ts-expect-error insertAlbum writes a library row; a move licenses a rotation row
export const albumRefusesMove: InsertAlbumBasis = { kind: 'legacy_move', fromRotationId: 1 };

// @ts-expect-error addToRotation writes a rotation row; an import licenses a library row
export const rotationRefusesImport: AddToRotationBasis = { kind: 'legacy_import', rotationId: 1 };

// @ts-expect-error fileLibraryRelease hands its one basis to both inserts, so an import would reach a rotation insert
export const filingRefusesImport: FileLibraryReleaseBasis = { kind: 'legacy_import', rotationId: 1 };

// @ts-expect-error nor may a move reach its library insert
export const filingRefusesMove: FileLibraryReleaseBasis = { kind: 'legacy_move', fromRotationId: 1 };
