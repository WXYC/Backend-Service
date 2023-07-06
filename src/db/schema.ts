import { InferModel } from 'drizzle-orm';
import {
  pgSchema,
  pgTable,
  integer,
  smallint,
  varchar,
  serial,
  boolean,
  text,
  timestamp,
  time,
  index,
  pgEnum,
  date,
} from 'drizzle-orm/pg-core';

export const wxyc_schema = pgSchema('wxyc_schema');

export type NewDJ = InferModel<typeof djs, 'insert'>;
export type DJ = InferModel<typeof djs, 'select'>;
export const djs = wxyc_schema.table(
  'djs',
  {
    id: serial('id').primaryKey(),
    dj_name: varchar('dj_name').notNull(),
    real_name: varchar('real_name').notNull(),
    email: varchar('email').notNull(),
    shows_covered: smallint('shows_covered').default(0).notNull(),
    add_date: date('add_date').defaultNow().notNull(),
    last_modified: timestamp('last_modified').defaultNow().notNull(),
  },
  (table) => {
    return {
      emailIdx: index('email_idx').on(table.email),
    };
  }
);

//TODO: Implement a way to track show covers further into the future (maybe do most of the date processing client side?)
// days {0: mon, 1: tue, ... , 6: sun}
export const schedule = wxyc_schema.table('schedule', {
  id: serial('id').primaryKey(),
  day: smallint('day').notNull(),
  start_time: time('start_time').notNull(),
  show_duration: smallint('show_duration').notNull(), // Hours!
  specialty_id: integer('specialty_id')
    .references(() => specialty_shows.id)
    .notNull(),
  assigned_dj_id: integer('assigned_dj_id').references(() => djs.id),
  assigned_dj_id2: integer('assigned_dj_id2').references(() => djs.id),
  cover_dj_id: integer('cover_dj_id').references(() => djs.id),
  needs_cover: boolean('needs_cover').default(false).notNull(),
});

export type newArtist = InferModel<typeof artists, 'insert'>;
export type Artist = InferModel<typeof artists, 'select'>;
export const artists = wxyc_schema.table(
  'artists',
  {
    id: serial('id').primaryKey(),
    artist_name: varchar('artist_name', { length: 128 }).notNull(),
    code_letters: varchar('code_letters', { length: 2 }).notNull(),
    code_artist_number: smallint('code_artist_number').notNull(),
    add_date: date('add_date').defaultNow().notNull(),
    last_modified: timestamp('last_modified').defaultNow().notNull(),
  },
  (table) => {
    return {
      artistNameIdx: index('artist_name_idx').on(table.artist_name),
    };
  }
);

export type newAlbumFormat = InferModel<typeof format, 'insert'>;
export type AlbumFormat = InferModel<typeof format, 'select'>;
//cd, cdr, vinyl, vinyl - 7", vinyl - 12", 'vinyl - LP'
export const format = wxyc_schema.table('format', {
  id: serial('id').primaryKey(),
  format_name: varchar('format_name').notNull(),
  is_vinyl: boolean('is_vinyl').notNull(), //0 - cd, 1 - vinyl
  date_added: date('add_date').defaultNow().notNull(),
});

//TODO: Create an entry with id 0 for flowsheet entries for outside albums
export type newAlbum = InferModel<typeof library, 'insert'>;
export type Album = InferModel<typeof library, 'select'>;
export const library = wxyc_schema.table(
  'library',
  {
    id: serial('id').primaryKey(),
    artist_id: integer('artist_id')
      .references(() => artists.id)
      .notNull(),
    genre_id: integer('genre_id')
      .references(() => genres.id)
      .notNull(),
    format_id: integer('format_id')
      .references(() => format.id)
      .notNull(),
    alternate_artist_name: varchar('alternate_artist_name', { length: 128 }),
    album_title: varchar('album_title', { length: 128 }).notNull(),
    label: varchar('label', { length: 128 }).notNull(),
    code_number: smallint('code_number').notNull(),
    disc_quantity: smallint('disc_quantity').default(1).notNull(),
    plays: integer('plays').default(0).notNull(),
    add_date: timestamp('add_date').defaultNow().notNull(),
    last_modified: timestamp('last_modified').defaultNow().notNull(),
  },
  (table) => {
    return {
      titleIdx: index('title_idx').on(table.album_title),
    };
  }
);

export type newRotationRelease = InferModel<typeof rotation, 'insert'>;
export type RotationRelease = InferModel<typeof rotation, 'select'>;
export const freqEnum = pgEnum('freq_enum', ['S', 'L', 'M', 'H']);
export const rotation = wxyc_schema.table('rotation', {
  id: serial('id').primaryKey(), //need to create an entry w/ id 0 for items not currently on rotation and items from outside the station
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(),
  play_freq: freqEnum('play_freq').notNull(),
  add_date: date('add_date').notNull(),
  kill_date: date('kill_date'),
  is_active: boolean('is_active').notNull(),
});

export type newTrack = InferModel<typeof flowsheet, 'insert'>;
export type Track = InferModel<typeof flowsheet, 'select'>;
export const flowsheet = wxyc_schema.table('flowsheet', {
  id: serial('id').primaryKey(),
  show_id: integer('show_id')
    .references(() => shows.id)
    .notNull(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(), // 0 for albums not from the library
  rotation_id: integer('rotation_id')
    .references(() => rotation.id)
    .notNull(), // 0 for releases not currently on rotation entries
  track_title: varchar('track_title', { length: 128 }).notNull(),
  album_title: varchar('album_title', { length: 128 }).notNull(),
  record_label: varchar('record_label', { length: 128 }).notNull(),
  play_order: serial('play_order').notNull(),
  play_timestamp: timestamp('play_timestamp').defaultNow().notNull(),
  request_flag: boolean('request_flag').default(false).notNull(),
});

export type newGenre = InferModel<typeof genres, 'insert'>;
export type Genre = InferModel<typeof genres, 'select'>;
export const genres = wxyc_schema.table('genres', {
  id: serial('id').primaryKey(),
  genre_name: varchar('genre_name', { length: 64 }).notNull(),
  description: text('description'),
  plays: integer('plays').default(0).notNull(),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});

export type newReview = InferModel<typeof reviews, 'insert'>;
export type Review = InferModel<typeof reviews, 'select'>;
export const reviews = wxyc_schema.table('reviews', {
  id: serial('id').primaryKey(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(),
  review: text('review').notNull(),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});

export type newBinEntry = InferModel<typeof bins, 'insert'>;
export type BinEntry = InferModel<typeof bins, 'select'>;
export const bins = wxyc_schema.table('bins', {
  id: serial('id').primaryKey(),
  dj_id: integer('dj_id')
    .references(() => djs.id)
    .notNull(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(),
});

export type newShow = InferModel<typeof shows, 'insert'>;
export type Show = InferModel<typeof shows, 'select'>;
export const shows = wxyc_schema.table('shows', {
  id: serial('id').primaryKey(),
  dj_id: integer('dj_id')
    .references(() => djs.id)
    .notNull(),
  dj_id2: integer('dj_id2').references(() => djs.id),
  dj_id3: integer('dj_id3').references(() => djs.id),
  specialty_id: integer('specialty_id') //0 for regular shows
    .references(() => specialty_shows.id)
    .notNull(),
  show_name: varchar('show_name', { length: 128 }).notNull(),
  start_time: timestamp('start_time').defaultNow().notNull(),
  end_time: timestamp('end_time'),
});

//create entry w/ ID 0 for regular shows
export type newSpecialtyShow = InferModel<typeof specialty_shows, 'insert'>;
export type SpecialtyShows = InferModel<typeof specialty_shows, 'select'>;
export const specialty_shows = wxyc_schema.table('specialty_shows', {
  id: serial('id').primaryKey(),
  specialty_name: varchar('specialty_name', { length: 64 }).notNull(),
  description: text('description'),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});
