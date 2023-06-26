import { InferModel } from 'drizzle-orm';
import {
  pgTable,
  integer,
  smallint,
  varchar,
  serial,
  smallserial,
  boolean,
  text,
  timestamp,
  index,
  pgEnum,
  date,
} from 'drizzle-orm/pg-core';

export type NewDJ = Omit<InferModel<typeof djs, 'insert'>, 'id'>;
export type DJ = InferModel<typeof djs, 'select'>;
export const djs = pgTable(
  'djs',
  {
    id: smallserial('id').primaryKey(),
    dj_name: varchar('dj_name').notNull(),
    real_name: varchar('real_name').notNull(),
    email: varchar('email').notNull(),
  },
  (table) => {
    return {
      emailIdx: index('email_idx').on(table.email),
    };
  }
);

export const formatEnum = pgEnum('format_enum', ['cd', 'cdr', 'vinyl', 'vinyl - 12"', 'vinyl - 7"', 'vinyl - LP']);
export const library = pgTable(
  'library',
  {
    id: serial('id').primaryKey(),
    artist_id: integer('artist_id').references(() => artists.id),
    genre_id: smallint('genre_id').references(() => genres.id),
    album_title: varchar('album_title', { length: 128 }),
    label: varchar('label', { length: 128 }),
    code_number: smallint('code_number'),
    format_flag: boolean('format_flag'), // cd - 0, vinyl - 1
    format: formatEnum('format'),
    add_date: timestamp('add_date'),
    plays: integer('plays'),
  },
  (table) => {
    return {
      titleIdx: index('title_idx').on(table.album_title),
    };
  }
);

export const freqEnum = pgEnum('freq_enum', ['single', 'light', 'medium', 'heavy']);
export const rotation = pgTable('rotation', {
  id: smallserial('id').primaryKey(),
  album_id: integer('album_id').references(() => library.id),
  play_freq: freqEnum('play_freq'),
  add_date: date('add_date'),
  kill_date: date('kill_date'),
  is_active: boolean('is_active'),
});

export const flowsheet = pgTable('flowsheet', {
  id: serial('id').primaryKey(),
  show_id: integer('show_id').references(() => shows.id),
  album_id: integer('album_id').references(() => library.id),
  rotation_id: smallint('rotation_id').references(() => rotation.id),
  track_title: varchar('track_title', { length: 128 }),
  entry_timestamp: timestamp('entry_timestamp'),
  request_flag: boolean('request_flag'),
});

export const artists = pgTable('artists', {
  id: serial('id').primaryKey(),
  artist_name: varchar('artist_name', { length: 128 }),
  code_letters: varchar('code_letters', { length: 2 }),
  code_artist_number: smallint('code_artist_number'),
});

export const genres = pgTable('genres', {
  id: smallserial('id').primaryKey(),
  genre_name: varchar('genre_name'),
  description: text('description'),
  plays: integer('plays'),
});

export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  album_id: integer('album_id').references(() => library.id),
  review: text('review'),
});

export const bins = pgTable('bins', {
  id: smallserial('id').primaryKey(),
  dj_id: smallint('dj_id').references(() => djs.id),
  album_id: integer('album_id').references(() => library.id),
});

export const shows = pgTable('shows', {
  id: serial('id').primaryKey(),
  dj_id: smallint('dj_id').references(() => djs.id),
  dj_id2: smallint('dj_id2').references(() => djs.id),
  dj_id3: smallint('dj_id3').references(() => djs.id),
  specialty_id: smallint('specialty_id').references(() => specialty_shows.id),
  show_name: varchar('show_name', { length: 128 }),
  start_time: timestamp('start_time'),
  end_time: timestamp('end_time'),
});

export const specialty_shows = pgTable('specialty_shows', {
  id: smallserial('id').primaryKey(),
  specialty_name: varchar('specialty_name', { length: 64 }),
  description: text('description'),
});
