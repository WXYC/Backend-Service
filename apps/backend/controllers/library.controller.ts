import { Request, RequestHandler } from 'express';
import {
  Album,
  Artist,
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  NewRotationRelease,
  RotationRelease,
} from '@wxyc/database';
import * as libraryService from '../services/library.service.js';
import * as labelsService from '../services/labels.service.js';
import { checkStreamingAvailability, searchDiscogs, isLmlConfigured } from '../services/lml/lml.client.js';
import WxycError from '../utils/error.js';

type NewAlbumRequest = {
  album_title: string;
  artist_name?: string;
  artist_id?: number;
  alternate_artist_name?: string;
  label: string;
  label_id?: number;
  genre_id: number;
  format_id: number;
  disc_quantity?: number;
};

//Check if artist exists.
//Add new album to library
export const addAlbum: RequestHandler = async (req: Request<object, object, NewAlbumRequest>, res) => {
  const { body } = req;
  if (
    body.album_title === undefined ||
    body.label === undefined ||
    body.genre_id === undefined ||
    body.format_id === undefined ||
    (body.artist_name === undefined && body.artist_id === undefined)
  ) {
    throw new WxycError('Missing Parameters: album_title, label, genre_id, format_id, artist_name, or artist_id', 400);
  }

  let artist_id = body.artist_id;
  if (artist_id === undefined && body.artist_name !== undefined) {
    artist_id = await libraryService.artistIdFromName(body.artist_name, body.genre_id);
  }
  if (!artist_id) {
    throw new WxycError(
      "Artist doesn't exist or hasn't released an album in this genre before. Add a new artist entry to the library",
      400
    );
  }

  // Resolve label string to label_id via upsert
  let label_id = body.label_id;
  if (label_id === undefined && body.label) {
    const resolvedLabel = await labelsService.createLabel(body.label);
    label_id = resolvedLabel.id;
  }

  const new_album: NewAlbum = {
    artist_id: artist_id,
    genre_id: body.genre_id,
    format_id: body.format_id,
    album_title: body.album_title,
    label: body.label,
    label_id: label_id,
    code_number: await libraryService.generateAlbumCodeNumber(artist_id),
    alternate_artist_name: body.alternate_artist_name,
    disc_quantity: body.disc_quantity,
  };

  let inserted_album: Album = await libraryService.insertAlbum(new_album);

  // Enrich with LML metadata (streaming + artwork) -- don't fail the insert
  if (isLmlConfigured()) {
    const artistName = body.alternate_artist_name || body.artist_name || '';
    const [streamingResult, artworkResult] = await Promise.allSettled([
      checkStreamingAvailability(artistName, body.album_title),
      searchDiscogs(artistName, body.album_title),
    ]);

    if (streamingResult.status === 'fulfilled' && streamingResult.value.on_streaming !== null) {
      try {
        inserted_album = await libraryService.updateOnStreaming(inserted_album.id, streamingResult.value.on_streaming);
      } catch (e) {
        console.warn('Failed to persist streaming status:', (e as Error).message);
      }
    } else if (streamingResult.status === 'rejected') {
      console.warn('Streaming check failed for new album:', streamingResult.reason);
    }

    if (artworkResult.status === 'fulfilled') {
      const top = artworkResult.value.results[0];
      if (top?.artwork_url && !top.artwork_url.includes('spacer.gif')) {
        try {
          await libraryService.updateArtworkUrl(inserted_album.id, top.artwork_url);
          (inserted_album as Record<string, unknown>).artwork_url = top.artwork_url;
        } catch (e) {
          console.warn('Failed to persist artwork URL:', (e as Error).message);
        }
      }
    } else {
      console.warn('Artwork fetch failed for new album:', artworkResult.reason);
    }
  }

  res.status(201).json(inserted_album);
};

type AlbumQueryParams = {
  artist_name?: string;
  album_title?: string;
  code_letters?: string;
  code_artist_number?: string;
  code_number?: number;
  n?: number;
  page?: number;
  on_streaming?: string;
};

export const searchForAlbum: RequestHandler = async (req: Request<object, object, object, AlbumQueryParams>, res) => {
  const { query } = req;
  if (
    query.artist_name === undefined &&
    query.album_title === undefined &&
    (query.code_letters === undefined || query.code_artist_number === undefined)
  ) {
    throw new WxycError(
      'Missing query parameter. Query must include: artist_name, album_title, or code_letters, code_artist_number, and code_number',
      400
    );
  }

  if (query.code_letters !== undefined && query.code_artist_number !== undefined) {
    //quickly look up albums by that artist
    throw new WxycError('TODO: Library Code Lookup', 501);
  }

  const onStreaming = query.on_streaming === 'true' ? true : query.on_streaming === 'false' ? false : undefined;

  const response = await libraryService.fuzzySearchLibrary(query.artist_name, query.album_title, query.n, onStreaming);
  const enriched = await libraryService.enrichWithArtwork(response as Array<Record<string, unknown>>);
  res.status(200).json(enriched);
};

type NewArtistRequest = {
  artist_name: string;
  alphabetical_name?: string;
  code_letters: string;
  genre_id: number;
  code_number: number;
};

export const addArtist: RequestHandler = async (req: Request<object, object, NewArtistRequest>, res) => {
  const { body } = req;
  if (
    body.artist_name === undefined ||
    body.code_letters === undefined ||
    body.genre_id === undefined ||
    body.code_number === undefined
  ) {
    throw new WxycError('Missing Request Parameters: artist_name, code_letters, genre_id, or code_number', 400);
  }

  const existingArtist = await libraryService.getArtistByCode(body.code_letters, body.genre_id, body.code_number);
  if (existingArtist) {
    res.status(409).json({
      message: 'Artist code already exists for that genre and code letters.',
      artist: existingArtist,
    });
    return;
  }

  const new_artist: NewArtist = {
    artist_name: body.artist_name,
    alphabetical_name: body.alphabetical_name ?? body.artist_name,
    code_letters: body.code_letters,
  };

  const response: Artist = await libraryService.insertArtist(new_artist);
  await libraryService.insertArtistGenreCrossreference(response.id, body.genre_id, body.code_number);
  res.status(201).json({
    ...response,
    code_number: body.code_number,
    genre_id: body.genre_id,
  });
};

type ArtistNumberPeekQuery = {
  code_letters?: string;
  genre_id?: string;
};

export const peekArtistNumber: RequestHandler = async (
  req: Request<object, object, object, ArtistNumberPeekQuery>,
  res
) => {
  const { query } = req;
  if (!query.code_letters || !query.genre_id) {
    throw new WxycError('Missing query parameters: code_letters and genre_id', 400);
  }

  const genreId = Number(query.genre_id);
  if (!Number.isFinite(genreId)) {
    throw new WxycError('Invalid genre_id', 400);
  }

  const nextCode = await libraryService.generateArtistNumber(query.code_letters, genreId);
  res.status(200).json({ next_code_number: nextCode });
};

export const getRotation: RequestHandler = async (req, res) => {
  const rotation = await libraryService.getRotationFromDB();
  res.status(200).json(rotation);
};

export type RotationAddRequest = Omit<NewRotationRelease, 'id'>;
export const addRotation: RequestHandler<object, unknown, NewRotationRelease> = async (req, res) => {
  if (req.body.album_id === undefined || req.body.rotation_bin === undefined) {
    throw new WxycError('Missing Parameters: album_id or rotation_bin', 400);
  }

  const rotationRelease: RotationRelease = await libraryService.addToRotation(req.body);
  res.status(201).json(rotationRelease);
};

export type KillRotationRelease = {
  rotation_id: number;
  kill_date?: string; //Accepts ISO8601 formatted dates YYYY-MM-DD
};

export const killRotation: RequestHandler<object, unknown, KillRotationRelease> = async (req, res) => {
  const { body } = req;

  if (body.rotation_id === undefined) {
    throw new WxycError('Bad Request, Missing Parameter: rotation_id', 400);
  }
  if (body.kill_date !== undefined && !libraryService.isISODate(body.kill_date)) {
    throw new WxycError('Bad Request, Incorrect Date Format: kill_date should be of form YYYY-MM-DD', 400);
  }

  const updatedRotation: RotationRelease = await libraryService.killRotationInDB(body.rotation_id, body.kill_date);
  if (updatedRotation !== undefined) {
    res.status(200).json(updatedRotation);
  } else {
    throw new WxycError('Rotation entry not found', 400);
  }
};

export const getFormats: RequestHandler = async (req, res) => {
  const formats = await libraryService.getFormatsFromDB();
  res.status(200).json(formats);
};

export const addFormat: RequestHandler = async (req, res) => {
  const { body } = req;
  if (body.name === undefined) {
    throw new WxycError('Bad Request, Missing Parameter: name', 400);
  }

  const newFormat: NewAlbumFormat = {
    format_name: body.name,
  };

  const insertion = await libraryService.insertFormat(newFormat);
  res.status(201).json(insertion);
};

export const getGenres: RequestHandler = async (req, res) => {
  const genres = await libraryService.getGenresFromDB();
  res.status(200).json(genres);
};

export const addGenre: RequestHandler = async (req, res) => {
  const { body } = req;
  if (body.name === undefined || body.description === undefined) {
    throw new WxycError('Bad Request, Parameters name and description are required.', 400);
  }

  const newGenre: NewGenre = {
    genre_name: body.name,
    description: body.description,
    plays: 0,
    add_date: new Date().toISOString(),
    last_modified: new Date(),
  };

  const insertion = await libraryService.insertGenre(newGenre);

  res.status(201).json(insertion);
};

export const getAlbum: RequestHandler<object, unknown, unknown, { album_id: string }> = async (req, res) => {
  const { query } = req;
  if (query.album_id === undefined) {
    throw new WxycError('Bad Request, missing album identifier: album_id', 400);
  }

  const album = await libraryService.getAlbumFromDB(parseInt(query.album_id));
  res.status(200).json(album);
};

const parseAlbumId = (rawId: string): number => {
  const albumId = Number(rawId);
  if (!Number.isInteger(albumId) || albumId <= 0) {
    throw new WxycError('Invalid album ID', 400);
  }
  return albumId;
};

export const markMissing: RequestHandler<{ id: string }> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);

  const result = await libraryService.markAlbumMissing(albumId);
  if (!result) throw new WxycError('Album not found', 404);

  const album = await libraryService.getAlbumFromDB(albumId);
  res.status(200).json(album);
};

export const markFound: RequestHandler<{ id: string }> = async (req, res) => {
  const albumId = parseAlbumId(req.params.id);

  const result = await libraryService.markAlbumFound(albumId);
  if (!result) throw new WxycError('Album not found', 404);

  const album = await libraryService.getAlbumFromDB(albumId);
  res.status(200).json(album);
};
