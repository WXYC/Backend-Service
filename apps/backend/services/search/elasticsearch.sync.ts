import type { LibraryArtistViewEntry } from '@wxyc/database';

/**
 * Index a single library document into Elasticsearch.
 * Stub — implemented in PR 2.
 */
export async function indexLibraryDocument(_doc: LibraryArtistViewEntry): Promise<void> {
  // TODO: PR 2 — dual-write sync
}

/**
 * Remove a library document from the Elasticsearch index by ID.
 * Stub — implemented in PR 2.
 */
export async function removeLibraryDocument(_id: number): Promise<void> {
  // TODO: PR 2 — dual-write sync
}

/**
 * Full reindex: read all rows from library_artist_view and bulk-index into ES.
 * Stub — implemented in PR 2.
 */
export async function bulkIndexLibrary(): Promise<void> {
  // TODO: PR 2 — bulk reindex job
}
