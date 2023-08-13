import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle_client';
import {
  NewAlbum,
  NewArtist,
  library,
  artists,
  library_artist_view,
  rotation,
  format,
  rotation_library_view,
  RotationRelease,
} from '../db/schema';
import { RotationAddRequest } from '../controllers/library.controller';

export const getFormatsFromDB = async () => {
  const formats = await db
    .select()
    .from(format)
    .where(sql`true`);
  return formats;
};

export const getRotationFromDB = async () => {
  const rotation_albums = await db
    .select({
      library_id: library.id,
      rotation_id: rotation.id,
      label: library.label,
      play_freq: rotation.play_freq,
      album_title: library.album_title,
      artist_name: artists.artist_name,
      kill_date: rotation.kill_date,
    })
    .from(library)
    .innerJoin(rotation, eq(library.id, rotation.album_id))
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .where(sql`${rotation.kill_date} < CURRENT_DATE OR ${rotation.kill_date} IS NULL`);

  // drizzle doesn't support renaming columns with "as" at the moment, so this is broken
  // const rotation_albums = await db
  //   .select()
  //   .from(rotation_library_view)
  //   .where(sql`${rotation_library_view.kill_date} < CURRENT_DATE OR ${rotation_library_view.kill_date} IS NULL`);
  return rotation_albums;
};

export const addToRotation = async (newRotation: RotationAddRequest) => {
  const insertedRotation: RotationRelease[] = await db.insert(rotation).values(newRotation).returning();
  return insertedRotation[0];
};

export const insertAlbum = async (newAlbum: NewAlbum) => {
  const response = await db.insert(library).values(newAlbum).returning();
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
  return response;

  // trying to get something like this working, but having type issues using orderBy method with 2 computed columns
  // maybe at some point for more type safety 🤷

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

export const artistIdFromName = async (artist_name: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ id: artists.id })
    .from(artists)
    .where(sql`lower(${artists.artist_name}) = lower(${artist_name}) AND ${artists.genre_id} = ${genre_id}`)
    .limit(1);

  if (!response.length) {
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

export const generateArtistNumber = async (code_letters: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ code_artist_number: artists.code_artist_number })
    .from(artists)
    .where(sql`${artists.code_letters} = ${code_letters} AND ${artists.genre_id} = ${genre_id}`)
    .orderBy(({ code_artist_number }) => desc(code_artist_number))
    .limit(1);

  let code_artist_number = 1;
  if (response.length) {
    code_artist_number = response[0].code_artist_number + 1; //otherwise we increment on the last value
  }
  return code_artist_number;
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: artists.code_letters,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      album_title: library.album_title,
      record_label: library.label,
      plays: library.plays,
      add_date: library.add_date,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .where(eq(library.id, album_id))
    .limit(1);

  return album[0];
};
