import type { LibraryArtistViewEntry } from '@wxyc/database';
import { getElasticsearchClient } from './elasticsearch.client.js';
import { getLibraryIndexName } from './elasticsearch.indices.js';

/**
 * Map an ES hit _source to the LibraryArtistViewEntry shape used by the rest
 * of the codebase, so the facade can swap backends transparently.
 */
function hitToViewEntry(source: Record<string, unknown>): LibraryArtistViewEntry {
  return {
    id: source.id as number,
    artist_name: source.artist_name as string,
    alphabetical_name: source.alphabetical_name as string,
    album_title: source.album_title as string,
    label: (source.label as string) ?? null,
    genre_name: source.genre_name as string,
    format_name: source.format_name as string,
    rotation_bin: (source.rotation_bin as string) ?? null,
    code_letters: source.code_letters as string,
    code_artist_number: source.code_artist_number as number,
    code_number: source.code_number as number,
    add_date: source.add_date as unknown as Date,
  };
}

/**
 * Full library search via Elasticsearch.
 *
 * Supports three modes matching the pg_trgm implementation:
 * 1. Free-text query across artist_name and album_title (multi_match)
 * 2. Separate artist + title filters (bool/should)
 * 3. Returns empty when no parameters are provided
 */
export async function searchLibraryES(
  query?: string,
  artist?: string,
  title?: string,
  limit = 5
): Promise<LibraryArtistViewEntry[]> {
  if (!query && !artist && !title) return [];

  const client = getElasticsearchClient()!;
  const index = getLibraryIndexName();

  let body: Record<string, unknown>;

  if (query) {
    body = {
      query: {
        multi_match: {
          query,
          fields: ['artist_name^2', 'album_title'],
          fuzziness: 'AUTO',
        },
      },
    };
  } else {
    const should: Record<string, unknown>[] = [];
    if (artist) {
      should.push({ match: { artist_name: { query: artist, fuzziness: 'AUTO', boost: 2 } } });
    }
    if (title) {
      should.push({ match: { album_title: { query: title, fuzziness: 'AUTO' } } });
    }
    body = {
      query: {
        bool: {
          should,
          minimum_should_match: 1,
        },
      },
    };
  }

  const response = await client.search({ index, size: limit, body });
  return (response.hits.hits as Array<{ _source: Record<string, unknown> }>).map((hit) => hitToViewEntry(hit._source));
}

/**
 * Find a similar artist name using ES fuzzy matching.
 * Returns the corrected name if a close but different match is found, null otherwise.
 */
export async function findSimilarArtistES(artistName: string, _threshold?: number): Promise<string | null> {
  const client = getElasticsearchClient()!;
  const index = getLibraryIndexName();

  const response = await client.search({
    index,
    size: 1,
    body: {
      query: {
        match: {
          artist_name: {
            query: artistName,
            fuzziness: 'AUTO',
          },
        },
      },
      _source: ['artist_name'],
    },
  });

  const hits = response.hits.hits as Array<{ _source: { artist_name: string } }>;
  if (hits.length === 0) return null;

  const match = hits[0]._source.artist_name;
  if (match.toLowerCase() === artistName.toLowerCase()) return null;

  console.log(`[Elasticsearch] Corrected artist '${artistName}' to '${match}'`);
  return match;
}

/**
 * Search for albums by title with fuzzy matching.
 */
export async function searchAlbumsByTitleES(albumTitle: string, limit = 5): Promise<LibraryArtistViewEntry[]> {
  const client = getElasticsearchClient()!;
  const index = getLibraryIndexName();

  const response = await client.search({
    index,
    size: limit,
    body: {
      query: {
        match: {
          album_title: {
            query: albumTitle,
            fuzziness: 'AUTO',
          },
        },
      },
    },
  });

  return (response.hits.hits as Array<{ _source: Record<string, unknown> }>).map((hit) => hitToViewEntry(hit._source));
}

/**
 * Search the library by artist name with fuzzy matching.
 */
export async function searchByArtistES(artistName: string, limit = 5): Promise<LibraryArtistViewEntry[]> {
  const client = getElasticsearchClient()!;
  const index = getLibraryIndexName();

  const response = await client.search({
    index,
    size: limit,
    body: {
      query: {
        match: {
          artist_name: {
            query: artistName,
            fuzziness: 'AUTO',
          },
        },
      },
    },
  });

  return (response.hits.hits as Array<{ _source: Record<string, unknown> }>).map((hit) => hitToViewEntry(hit._source));
}
