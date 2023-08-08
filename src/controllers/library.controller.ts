import { RequestHandler, Request } from 'express';
import { NewAlbum, Album, NewArtist, Artist } from '../db/schema';
import * as libraryService from '../services/library.service';

type NewAlbumRequest = {
  album_title: string;
  artist_name?: string;
  artist_id?: number;
  alternate_artist_name?: string;
  label: string;
  genre_id: number;
  format_id: number;
  disc_quantity?: number;
};

//Check if artist exists.
//If not, add the artist (TODO: do this automatically).
//Add new album to library

export const post: RequestHandler = async (req: Request<object, object, NewAlbumRequest>, res, next) => {
  const body = req.body;
  if (
    body.album_title === undefined ||
    body.label === undefined ||
    body.genre_id === undefined ||
    body.format_id === undefined ||
    (body.artist_name === undefined && body.artist_id === undefined)
  ) {
    res.status(400);
    res.send('Missing Parameters: album_title, label, genre_id, format_id, artist_name, or artist_id');
  } else {
    let artist_id = body.artist_id;
    if (artist_id === undefined && body.artist_name !== undefined) {
      artist_id = await libraryService.artistIdFromName(body.artist_name);
    }
    if (!artist_id) {
      //TODO: Automatically add artist: Optional parameters artist_name & code letters?
      res.status(400);
      res.send("Artist doesn't exist. Add a new artist to the library");
    } else {
      try {
        const new_album: NewAlbum = {
          artist_id: artist_id,
          genre_id: body.genre_id,
          format_id: body.format_id,
          album_title: body.album_title,
          label: body.label,
          code_number: await libraryService.generateAlbumCodeNumber(artist_id),
          alternate_artist_name: body.alternate_artist_name,
          disc_quantity: body.disc_quantity,
        };
        const inserted_album: Album = await libraryService.insertAlbum(new_album);
        res.status(200);
        res.json(inserted_album);
      } catch (e) {
        console.error('Error: Could not insert new album');
        console.error(e);
        next(e);
      }
    }
  }
};

type AlbumQueryParams = {
  artist_name?: string;
  album_title?: string;
  code_letters?: string;
  code_artist_number?: string;
  code_number?: number;
  n?: number;
  page?: number;
};

export const get: RequestHandler = async (req: Request<object, object, object, AlbumQueryParams>, res, next) => {
  const { query } = req;
  if (
    query.artist_name === undefined &&
    query.album_title === undefined &&
    (query.code_letters === undefined || query.code_artist_number === undefined)
  ) {
    res.status(400);
    res.send(
      'Missing query parameter. Query must include: artist_name, album_title, or code_letters, code_artist_number, and code_number'
    );
  } else if (query.code_letters !== undefined && query.code_artist_number !== undefined) {
    //quickly look up albums by that artist
    res.status(501);
    res.send('todo');
  } else {
    try {
      const response = await libraryService.fuzzySearchLibrary(query.artist_name, query.album_title, query.n);
      console.log(response);
      res.json(response);
    } catch (e) {
      console.log("Error: Couldn't get album");
      console.log(e);
      next(e);
    }
  }
};

type NewArtistRequest = {
  artist_name: string;
  code_letters: string;
};

export const addArtist: RequestHandler = async (req: Request<object, object, NewArtistRequest>, res, next) => {
  const { body } = req;
  //TODO auto_generate artist code letters and make it an optional parameter
  if (body.artist_name === undefined || body.code_letters === undefined) {
    res.status(400);
    res.send('Missing Request Parameters: artist_name or code_letters');
  } else {
    try {
      const new_artist: NewArtist = {
        artist_name: body.artist_name,
        code_letters: body.code_letters,
        code_artist_number: await libraryService.generateArtistNumber(body.code_letters),
      };
      const response: Artist = await libraryService.insertArtist(new_artist);
      res.status(200);
      res.send(response);
    } catch (e) {
      next(e);
    }
  }
};

export const getRotation: RequestHandler = (req, res, next) => {
  res.status(501).send('todo');
};

export const getFormats: RequestHandler = async (req, res, next) => {
  try {
    const formats = await libraryService.getFormatsFromDB();
    res.status(200).json(formats);
  } catch (e) {
    console.error('Error retrieving formats from DB');
    next(e);
  }
};
