import { RequestHandler } from 'express';
import * as suggestService from '../services/suggest.service.js';
import WxycError from '../utils/error.js';

export const suggestArtistsEndpoint: RequestHandler<object, unknown, unknown, { q: string; limit?: string }> = async (
  req,
  res
) => {
  const query = req.query.q;
  if (!query) throw new WxycError('Missing required query parameter: q', 400);

  const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
  const artists = await suggestService.suggestArtists(query, limit);
  res.status(200).json(artists);
};

export const suggestTracksEndpoint: RequestHandler<
  object,
  unknown,
  unknown,
  { q: string; artist: string; limit?: string }
> = async (req, res) => {
  const query = req.query.q;
  const artist = req.query.artist;
  if (!query) throw new WxycError('Missing required query parameter: q', 400);
  if (!artist) throw new WxycError('Missing required query parameter: artist', 400);

  const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
  const tracks = await suggestService.suggestTracks(query, artist, limit);
  res.status(200).json(tracks);
};

export const getTrackDetailsEndpoint: RequestHandler<
  object,
  unknown,
  unknown,
  { artist: string; track: string }
> = async (req, res) => {
  const artist = req.query.artist;
  const track = req.query.track;
  if (!artist) throw new WxycError('Missing required query parameter: artist', 400);
  if (!track) throw new WxycError('Missing required query parameter: track', 400);

  const details = await suggestService.getTrackDetails(artist, track);
  res.status(200).json(details);
};
