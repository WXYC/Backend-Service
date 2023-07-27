import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import { NewAlbum, NewArtist, library, artists, library_artist_view } from '../db/schema';

export const insertAlbum = async (new_album: NewAlbum) => {
  const response = await db.insert(library).values(new_album).returning();
  return response[0];
};

//based on artist name and album title, retrieve n best matches from db
//let's build the where statement using drizzle's sql object
export const fuzzySearchLibrary = async (artist_name?: string, album_title?: string, n = 5) => {
  const query = sql`SELECT *, 
                    similarity(${library_artist_view.artist_name}, ${artist_name || ''}) AS artist_sml,
                    similarity(${library_artist_view.album_title}, ${album_title || ''}) AS album_sml
                      FROM ${library_artist_view}
                      WHERE ${library_artist_view.artist_name} % ${artist_name || ''} OR 
                            ${library_artist_view.album_title} % ${album_title || ''}
                      ORDER BY artist_sml DESC, album_sml DESC
                      LIMIT ${n}`;

  const response = await db.execute(query);
  console.log(response);
  return response;

  // trying to get something like this working, but having type issues on orderBy method
  // const query1 = db
  //   .select({
  //     library_id: library_artist_view.library_id,
  //     album_title: library_artist_view.album_title,
  //     artist_name: library_artist_view.artist_name,
  //     artist_similarity: sql`similarity(${library_artist_view.artist_name}, ${artist_name || ''})`,
  //     album_similarity: sql`similarity(${library_artist_view.album_title}, ${album_title || ''})`,
  //   })
  //   .from(library_artist_view)
  //   .where(
  //     sql`${library_artist_view.album_title} % ${album_title} OR ${library_artist_view.artist_name} % ${artist_name}`
  //   )
  //   .orderBy(
  //     ({ album_similarity }) =>
  //       desc(
  //         album_similarity
  //       ) /*, ({ artist_similarity, album_similarity }) => {desc(artist_similarity), desc(album_similarity)}*/
  //   )
  //   .limit(n)
  //   .toSQL();
  // console.log(query1);
};

export const artistIdFromName = async (artist_name: string): Promise<number> => {
  const response = await db
    .select({ id: artists.id })
    .from(artists)
    .where(sql`lower(${artists.artist_name}) = lower(${artist_name})`)
    .limit(1);
  if (response[0].id === undefined) {
    return 0;
  } else {
    return response[0].id;
  }
};

export const insertArtist = async (new_artist: NewArtist) => {
  const response = await db.insert(artists).values(new_artist).returning();
  return response[0];
};

export const generateAlbumCodeNumber = async (artist_id: number): Promise<number> => {
  const response = await db
    .select({ code_number: library.code_number })
    .from(library)
    .where(eq(library.artist_id, artist_id))
    .orderBy(desc(library.code_number))
    .limit(1);
  //in case this is the first album
  let code_number = 1;
  if (response.length) {
    code_number = response[0].code_number + 1; //otherwise we increment on the last value
  }
  return code_number;
};

export const generateArtistNumber = async (code_letters: string): Promise<number> => {
  const response = await db
    .select({ code_artist_number: artists.code_artist_number })
    .from(artists)
    .where(sql`${artists.code_artist_number} = ${code_letters}`)
    .orderBy(({ code_artist_number }) => desc(code_artist_number))
    .limit(1);

  let code_artist_number = 1;
  if (response.length) {
    code_artist_number = response[0].code_artist_number + 1; //otherwise we increment on the last value
  }
  return code_artist_number;
};
