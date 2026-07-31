/**
 * Unit tests for ArtworkFinder (BS#1089).
 *
 * Focus: the finder must distinguish "every provider ran and confirmed no
 * match" from "at least one provider threw and never got to answer" — only
 * the former is a confirmed absence. Fake providers are injected directly
 * via the constructor (`new ArtworkFinder(providers)`), so these tests don't
 * need to mock the LML client or any provider module.
 */
import { ArtworkFinder } from '../../../apps/backend/services/artwork/finder';
import type { ArtworkProvider } from '../../../apps/backend/services/artwork/providers/base';
import type { ArtworkRequest, ArtworkSearchResult } from '../../../apps/backend/services/requestLine/types';

function confirmedEmptyProvider(name: string): ArtworkProvider {
  return {
    name,
    search: (_request: ArtworkRequest) => Promise.resolve([]),
  };
}

function throwingProvider(name: string, error: Error = new Error(`${name} down`)): ArtworkProvider {
  return {
    name,
    search: (_request: ArtworkRequest) => Promise.reject<ArtworkSearchResult[]>(error),
  };
}

function matchingProvider(name: string, result: ArtworkSearchResult): ArtworkProvider {
  return {
    name,
    search: (_request: ArtworkRequest) => Promise.resolve([result]),
  };
}

const sampleRequest: ArtworkRequest = { artist: 'Chuquimamani-Condori', album: 'Edits' };

describe('ArtworkFinder', () => {
  it('returns a confirmed-empty response (not errored) when every provider runs and finds nothing', async () => {
    const finder = new ArtworkFinder([confirmedEmptyProvider('discogs'), confirmedEmptyProvider('lastfm')]);

    const result = await finder.find(sampleRequest);

    expect(result.artworkUrl).toBeNull();
    expect(result.errored).toBeFalsy();
  });

  it('returns an errored response (not a confirmed absence) when a provider throws and nothing else is found', async () => {
    // Mirrors the production failure mode: LML times out (DiscogsProvider
    // throws), and the lower-confidence fallbacks genuinely have nothing —
    // this must NOT look identical to "confirmed no artwork."
    const finder = new ArtworkFinder([
      throwingProvider('discogs'),
      confirmedEmptyProvider('lastfm'),
      confirmedEmptyProvider('itunes'),
    ]);

    const result = await finder.find(sampleRequest);

    expect(result.artworkUrl).toBeNull();
    expect(result.errored).toBe(true);
  });

  it('still tries every provider after one throws (Discogs failing must not skip Last.fm/iTunes)', async () => {
    const lastFmSearch = jest.fn((_request: ArtworkRequest): Promise<ArtworkSearchResult[]> => Promise.resolve([]));
    const finder = new ArtworkFinder([
      throwingProvider('discogs'),
      { name: 'lastfm', search: lastFmSearch },
      confirmedEmptyProvider('itunes'),
    ]);

    await finder.find(sampleRequest);

    expect(lastFmSearch).toHaveBeenCalledTimes(1);
  });

  it('returns the match — not tagged errored — when a later provider succeeds after an earlier one threw', async () => {
    // Constraint from the issue: "A successful Last.fm or iTunes match after
    // a Discogs error is 'found, cache positive' — don't infect the
    // negative cache from a partially-failing fallback chain."
    const match: ArtworkSearchResult = {
      artworkUrl: 'https://lastfm.example/edits.jpg',
      releaseUrl: 'https://last.fm/music/Chuquimamani-Condori/Edits',
      album: 'Edits',
      artist: 'Chuquimamani-Condori',
      source: 'lastfm',
      confidence: 0.7,
    };
    const finder = new ArtworkFinder([throwingProvider('discogs'), matchingProvider('lastfm', match)]);

    const result = await finder.find(sampleRequest);

    expect(result.artworkUrl).toBe(match.artworkUrl);
    expect(result.source).toBe('lastfm');
    expect(result.errored).toBeFalsy();
  });

  it('returns a confirmed-empty response (not errored) for an empty request — no provider is even asked', async () => {
    const discogsSearch = jest.fn((_request: ArtworkRequest): Promise<ArtworkSearchResult[]> => Promise.resolve([]));
    const finder = new ArtworkFinder([{ name: 'discogs', search: discogsSearch }]);

    const result = await finder.find({});

    expect(result.artworkUrl).toBeNull();
    expect(result.errored).toBeFalsy();
    expect(discogsSearch).not.toHaveBeenCalled();
  });

  it('picks the highest-confidence result when multiple providers find matches', async () => {
    const lowConfidence: ArtworkSearchResult = {
      artworkUrl: 'https://itunes.example/edits.jpg',
      releaseUrl: 'https://itunes.example/release',
      album: 'Edits',
      artist: 'Chuquimamani-Condori',
      source: 'itunes',
      confidence: 0.4,
    };
    const highConfidence: ArtworkSearchResult = {
      artworkUrl: 'https://discogs.example/edits.jpg',
      releaseUrl: 'https://discogs.com/release/1',
      album: 'Edits',
      artist: 'Chuquimamani-Condori',
      source: 'discogs',
      confidence: 0.95,
    };
    const finder = new ArtworkFinder([matchingProvider('itunes', lowConfidence), matchingProvider('discogs', highConfidence)]);

    const result = await finder.find(sampleRequest);

    expect(result.source).toBe('discogs');
    expect(result.artworkUrl).toBe(highConfidence.artworkUrl);
  });
});
