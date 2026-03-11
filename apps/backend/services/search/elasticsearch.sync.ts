import type { LibraryArtistViewEntry } from '@wxyc/database';
import { db, library_artist_view } from '@wxyc/database';
import { eq } from 'drizzle-orm';
import { getElasticsearchClient } from './elasticsearch.client.js';
import { ensureLibraryIndex, getLibraryIndexName } from './elasticsearch.indices.js';

const BULK_BATCH_SIZE = 500;

/**
 * Convert a view entry to an ES document body, serializing dates for the ES date mapping.
 */
function toEsDocument(doc: LibraryArtistViewEntry): Record<string, unknown> {
  return {
    id: doc.id,
    artist_name: doc.artist_name,
    alphabetical_name: doc.alphabetical_name,
    album_title: doc.album_title,
    label: doc.label,
    genre_name: doc.genre_name,
    format_name: doc.format_name,
    rotation_bin: doc.rotation_bin,
    code_letters: doc.code_letters,
    code_artist_number: doc.code_artist_number,
    code_number: doc.code_number,
    add_date: doc.add_date instanceof Date ? doc.add_date.toISOString() : String(doc.add_date),
  };
}

/**
 * Query `library_artist_view` by album ID to get the full denormalized row.
 */
async function getLibraryViewEntryById(albumId: number): Promise<LibraryArtistViewEntry | null> {
  const rows = await db
    .select()
    .from(library_artist_view)
    .where(eq(library_artist_view.id, albumId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Index a single library document into Elasticsearch.
 * No-ops when ES is disabled. Errors are logged, never thrown.
 */
async function indexLibraryDocument(doc: LibraryArtistViewEntry): Promise<void> {
  const client = getElasticsearchClient();
  if (!client) return;

  await client.index({
    index: getLibraryIndexName(),
    id: String(doc.id),
    body: toEsDocument(doc),
  });
}

/**
 * Index a library document by album ID. Queries the view, then indexes into ES.
 * Entire body is wrapped in try/catch — logs errors, never throws.
 * Safe to call fire-and-forget from dual-write callers.
 */
export async function indexLibraryDocumentById(albumId: number): Promise<void> {
  try {
    const client = getElasticsearchClient();
    if (!client) return;

    const doc = await getLibraryViewEntryById(albumId);
    if (!doc) {
      console.warn(`[Elasticsearch] Album ${albumId} not found in library_artist_view, skipping index`);
      return;
    }

    await indexLibraryDocument(doc);
  } catch (error) {
    console.error(`[Elasticsearch] Failed to index album ${albumId}:`, error);
  }
}

/**
 * Remove a library document from the Elasticsearch index by ID.
 * Ignores 404 (document may not exist in ES yet). Never throws.
 */
export async function removeLibraryDocument(id: number): Promise<void> {
  try {
    const client = getElasticsearchClient();
    if (!client) return;

    await client.delete({
      index: getLibraryIndexName(),
      id: String(id),
    });
  } catch (error: unknown) {
    const statusCode = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
    if (statusCode === 404) return;
    console.error(`[Elasticsearch] Failed to remove document ${id}:`, error);
  }
}

/**
 * Full reindex: read all rows from library_artist_view and bulk-index into ES.
 * Returns counts for observability. No-ops gracefully when ES is disabled.
 */
export async function bulkIndexLibrary(): Promise<{ indexed: number; errors: number }> {
  const client = getElasticsearchClient();
  if (!client) return { indexed: 0, errors: 0 };

  await ensureLibraryIndex();

  const rows: LibraryArtistViewEntry[] = await db.select().from(library_artist_view);

  if (rows.length === 0) {
    return { indexed: 0, errors: 0 };
  }

  const indexName = getLibraryIndexName();
  let totalErrors = 0;

  for (let i = 0; i < rows.length; i += BULK_BATCH_SIZE) {
    const batch = rows.slice(i, i + BULK_BATCH_SIZE);
    const operations = batch.flatMap((doc) => [
      { index: { _index: indexName, _id: String(doc.id) } },
      toEsDocument(doc),
    ]);

    const response = await client.bulk({ operations });

    if (response.errors) {
      const errorItems = (response.items as Array<{ index?: { status?: number; error?: unknown } }>).filter(
        (item) => item.index && item.index.status && item.index.status >= 400
      );
      totalErrors += errorItems.length;
      console.error(`[Elasticsearch] Bulk batch had ${errorItems.length} errors`);
    }
  }

  console.log(`[Elasticsearch] Reindex complete: ${rows.length} documents, ${totalErrors} errors`);
  return { indexed: rows.length, errors: totalErrors };
}
