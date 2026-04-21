import { RequestHandler } from 'express';
import * as suggestService from '../services/suggest.service.js';

export const suggestArtistsEndpoint: RequestHandler<object, unknown, unknown, { q: string; limit?: string }> = async (
  req,
  res,
  next
) => {
  const query = req.query.q;
  if (!query) {
    res.status(400).json({ message: 'Missing required query parameter: q' });
  } else {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
      const artists = await suggestService.suggestArtists(query, limit);
      res.status(200).json(artists);
    } catch (e) {
      console.error('Error suggesting artists');
      console.error(e);
      next(e);
    }
  }
};

export const suggestTracksEndpoint: RequestHandler<
  object,
  unknown,
  unknown,
  { q: string; artist: string; limit?: string }
> = async (req, res, next) => {
  const query = req.query.q;
  const artist = req.query.artist;
  if (!query) {
    res.status(400).json({ message: 'Missing required query parameter: q' });
  } else if (!artist) {
    res.status(400).json({ message: 'Missing required query parameter: artist' });
  } else {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
      const tracks = await suggestService.suggestTracks(query, artist, limit);
      res.status(200).json(tracks);
    } catch (e) {
      console.error('Error suggesting tracks');
      console.error(e);
      next(e);
    }
  }
};

export const getTrackDetailsEndpoint: RequestHandler<
  object,
  unknown,
  unknown,
  { artist: string; track: string }
> = async (req, res, next) => {
  const artist = req.query.artist;
  const track = req.query.track;
  if (!artist) {
    res.status(400).json({ message: 'Missing required query parameter: artist' });
  } else if (!track) {
    res.status(400).json({ message: 'Missing required query parameter: track' });
  } else {
    try {
      const details = await suggestService.getTrackDetails(artist, track);
      res.status(200).json(details);
    } catch (e) {
      console.error('Error getting track details');
      console.error(e);
      next(e);
    }
  }
};
