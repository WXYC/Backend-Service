/**
 * LML's release and artist responses mapped onto the eight extended
 * `album_metadata` columns (BS#1442). Pure. Each column belongs to the release
 * the row already names or to its primary artist; nothing here searches.
 */

import type * as Lml from '@wxyc/lml-client';

/** Discogs' "Various" artist, a compilation's `artist_id`. Nothing downstream
 * special-cases it, so its profile must never reach the artist panel. */
export const VARIOUS_ARTISTS_DISCOGS_ID = 194;

/** Discogs' placeholder credits, which name no real artist: 355 "Unknown Artist"
 * and 118760 "No Artist". Like Various, their profile and image must never
 * reach the artist panel, so they get no artist columns either. */
export const PLACEHOLDER_ARTIST_DISCOGS_IDS: ReadonlySet<number> = new Set([355, 118760]);

/** Migration 0102's sizes. A longer value is dropped, never truncated. */
export const COLUMN_MAX_LENGTH = { label: 255, full_release_date: 32, artist_image_url: 512 } as const;
export type TooLongColumn = keyof typeof COLUMN_MAX_LENGTH;

// prettier-ignore
export const EXTENDED_COLUMNS = ['tracklist', 'genres', 'styles', 'label', 'full_release_date', 'discogs_artist_id', 'artist_image_url', 'bio_tokens'] as const;
export type ExtendedColumn = (typeof EXTENDED_COLUMNS)[number];

/** The release id in a stored `discogs_url`: the `/release/(\d+)` parse private
 * to `proxy.controller.ts`, bounded like the cohort's SQL match (1 to 9 digits,
 * no leading zero, as `album-metadata-reask` does) so the two always agree.
 * Master URLs, `''` and null give undefined. */
export const parseDiscogsReleaseId = (url: string | null | undefined): number | undefined => {
  const digits = url?.match(/\/release\/([1-9]\d{0,8})(?!\d)/)?.[1];
  return digits === undefined ? undefined : Number(digits);
};

/** Only `single` gets artist columns; the rest leave them NULL and skip the artist fetch. */
export const ARTIST_GATES = ['single', 'various', 'placeholder_artist', 'multiple_credits', 'no_artist_id'] as const;
export type ArtistGate = (typeof ARTIST_GATES)[number];

export interface ReleaseColumns {
  tracklist: Lml.DiscogsTrackItem[] | null;
  genres: string[] | null;
  styles: string[] | null;
  label: string | null;
  full_release_date: string | null;
  discogs_artist_id: number | null;
}

export interface ArtistColumns {
  artist_image_url: string | null;
  bio_tokens: Lml.DiscogsResolvedToken[] | null;
}

/** Mapped columns, plus the ones left NULL because the value was too long. */
export interface Mapped<Columns> {
  columns: Columns;
  tooLong: TooLongColumn[];
}

const nonEmpty = <T>(values: T[] | null | undefined): T[] | null => (values?.length ? values : null);

const fit = (value: string | null | undefined, column: TooLongColumn, tooLong: TooLongColumn[]): string | null => {
  if (value && value.length > COLUMN_MAX_LENGTH[column]) {
    tooLong.push(column);
    return null;
  }
  return value || null;
};

const gateOf = (release: Lml.DiscogsReleaseMetadata): ArtistGate => {
  if (release.artist_id === VARIOUS_ARTISTS_DISCOGS_ID) {
    return 'various';
  }
  if (release.artist_id != null && PLACEHOLDER_ARTIST_DISCOGS_IDS.has(release.artist_id)) {
    return 'placeholder_artist';
  }
  if ((release.artists ?? []).length > 1) {
    return 'multiple_credits';
  }
  return release.artist_id ? 'single' : 'no_artist_id';
};

/** The six release-scoped columns and the compilation gate. Empty arrays and
 * empty scalars are NULL; `discogs_artist_id` is set only for `single`. */
export const mapRelease = (release: Lml.DiscogsReleaseMetadata): Mapped<ReleaseColumns> & { gate: ArtistGate } => {
  const tooLong: TooLongColumn[] = [];
  const gate = gateOf(release);
  const columns: ReleaseColumns = {
    tracklist: nonEmpty(release.tracklist),
    genres: nonEmpty(release.genres),
    styles: nonEmpty(release.styles),
    label: fit(release.label, 'label', tooLong),
    full_release_date: fit(release.released, 'full_release_date', tooLong),
    discogs_artist_id: gate === 'single' ? (release.artist_id ?? null) : null,
  };
  return { columns, gate, tooLong };
};

/** The two artist-scoped columns. Whether tokens may sit beside the row's bio is the write's call. */
export const mapArtist = (artist: Lml.DiscogsArtistDetails): Mapped<ArtistColumns> => {
  const tooLong: TooLongColumn[] = [];
  const columns = {
    artist_image_url: fit(artist.image_url, 'artist_image_url', tooLong),
    bio_tokens: nonEmpty(artist.profile_tokens),
  };
  return { columns, tooLong };
};
