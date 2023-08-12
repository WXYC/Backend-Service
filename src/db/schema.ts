import { InferModel, sql, eq } from 'drizzle-orm';
import {
  pgSchema,
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
export const djs = wxyc_schema.table('djs', {
  id: serial('id').primaryKey(),
  cognito_user_name: varchar('cognito_user_name').notNull().unique(),
  real_name: varchar('real_name'),
  shows_covered: smallint('shows_covered').default(0).notNull(),
  add_date: date('add_date').defaultNow().notNull(),
});

export type NewShift = InferModel<typeof schedule, 'insert'>;
export type Shift = InferModel<typeof schedule, 'select'>;

// days {0: mon, 1: tue, ... , 6: sun}
// n shows from now can be found with query:
//SELECT date_trunc('week', current_timestamp + timestamp '${n} weeks') + interval '${schedule.day} days' + ${schedule.time}
//or really it could be done client side really easily...
export const schedule = wxyc_schema.table('schedule', {
  id: serial('id').primaryKey(),
  day: smallint('day').notNull(),
  start_time: time('start_time').notNull(),
  show_duration: smallint('show_duration').notNull(), // In hours
  specialty_id: integer('specialty_id').references(() => specialty_shows.id), //null for regular shows
  assigned_dj_id: integer('assigned_dj_id').references(() => djs.id),
  assigned_dj_id2: integer('assigned_dj_id2').references(() => djs.id),
});

export type NewShiftCover = InferModel<typeof shift_covers, 'insert'>;
export type ShiftCover = InferModel<typeof shift_covers, 'select'>;
export const shift_covers = wxyc_schema.table('shift_covers', {
  id: serial('id').primaryKey(),
  schedule_id: serial('schedule_id')
    .references(() => schedule.id)
    .notNull(),
  shift_timestamp: timestamp('shift_timestamp').notNull(),
  cover_dj_id: integer('cover_dj_id').references(() => djs.id),
  covered: boolean('covered').default(false),
});

export type NewArtist = InferModel<typeof artists, 'insert'>;
export type Artist = InferModel<typeof artists, 'select'>;
export const artists = wxyc_schema.table(
  'artists',
  {
    id: serial('id').primaryKey(),
    genre_id: integer('genre_id')
      .references(() => genres.id)
      .notNull(),
    artist_name: varchar('artist_name', { length: 128 }).notNull(),
    code_letters: varchar('code_letters', { length: 2 }).notNull(),
    code_artist_number: smallint('code_artist_number').notNull(),
    add_date: date('add_date').defaultNow().notNull(),
    last_modified: timestamp('last_modified').defaultNow().notNull(),
  },
  (table) => {
    return {
      artistNameTrgmIdx: index('artist_name_trgm_idx')
        .on(table.artist_name)
        .using(sql`gin (${table.artist_name} gin_trgm_ops)`),
      codeLettersIdx: index('code_letters_idx').on(table.code_letters),
    };
  }
);

export type NewAlbumFormat = InferModel<typeof format, 'insert'>;
export type AlbumFormat = InferModel<typeof format, 'select'>;
//cd, cdr, vinyl, vinyl - 7", vinyl - 12", 'vinyl - LP'
export const format = wxyc_schema.table('format', {
  id: serial('id').primaryKey(),
  format_name: varchar('format_name').notNull(),
  date_added: date('add_date').defaultNow().notNull(),
});

//TODO: Create an entry with id 0 for flowsheet entries for outside albums
export type NewAlbum = InferModel<typeof library, 'insert'>;
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
    label: varchar('label', { length: 128 }),
    code_number: smallint('code_number').notNull(),
    disc_quantity: smallint('disc_quantity').default(1).notNull(),
    plays: integer('plays').default(0).notNull(),
    add_date: timestamp('add_date').defaultNow().notNull(),
    last_modified: timestamp('last_modified').defaultNow().notNull(),
  },
  (table) => {
    return {
      titleTrgmIdx: index('title_trgm_idx')
        .on(table.album_title)
        .using(sql`gin (${table.album_title} gin_trgm_ops)`),
      genreIdIdx: index('genre_id_idx').on(table.genre_id),
      formatIdIdx: index('format_id_idx').on(table.format_id),
      artistIdIdx: index('artist_id_idx').on(table.artist_id),
    };
  }
);

export type NewRotationRelease = InferModel<typeof rotation, 'insert'>;
export type RotationRelease = InferModel<typeof rotation, 'select'>;
export const freqEnum = pgEnum('freq_enum', ['S', 'L', 'M', 'H']);
export const rotation = wxyc_schema.table(
  'rotation',
  {
    id: serial('id').primaryKey(), //need to create an entry w/ id 0 for items not currently on rotation and items from outside the station
    album_id: integer('album_id')
      .references(() => library.id)
      .notNull(),
    play_freq: freqEnum('play_freq').notNull(),
    add_date: date('add_date').defaultNow().notNull(),
    kill_date: date('kill_date'),
  },
  (table) => {
    return {
      albumIdIdx: index('album_id_idx').on(table.album_id),
    };
  }
);

export type NewFSEntry = InferModel<typeof flowsheet, 'insert'>;
export type FSEntry = InferModel<typeof flowsheet, 'select'>;
export const flowsheet = wxyc_schema.table('flowsheet', {
  id: serial('id').primaryKey(),
  show_id: integer('show_id')
    .references(() => shows.id)
    .notNull(),
  album_id: integer('album_id').references(() => library.id),
  rotation_id: integer('rotation_id').references(() => rotation.id),
  track_title: varchar('track_title', { length: 128 }).notNull(),
  album_title: varchar('album_title', { length: 128 }).notNull(),
  artist_name: varchar('artist_name', { length: 128 }).notNull(),
  record_label: varchar('record_label', { length: 128 }),
  play_order: serial('play_order').notNull(),
  request_flag: boolean('request_flag').default(false).notNull(),
  message: varchar('message', { length: 64 }),
});

export type NewGenre = InferModel<typeof genres, 'insert'>;
export type Genre = InferModel<typeof genres, 'select'>;
export const genres = wxyc_schema.table('genres', {
  id: serial('id').primaryKey(),
  genre_name: varchar('genre_name', { length: 64 }).notNull(),
  description: text('description'),
  plays: integer('plays').default(0).notNull(),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});

export type NewReview = InferModel<typeof reviews, 'insert'>;
export type Review = InferModel<typeof reviews, 'select'>;
export const reviews = wxyc_schema.table('reviews', {
  id: serial('id').primaryKey(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull()
    .unique(),
  review: text('review'),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
  author: varchar('author', { length: 32 }),
});

export type NewBinEntry = InferModel<typeof bins, 'insert'>;
export type BinEntry = InferModel<typeof bins, 'select'>;
export const bins = wxyc_schema.table('bins', {
  id: serial('id').primaryKey(),
  dj_id: integer('dj_id')
    .references(() => djs.id)
    .notNull(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(),
  track_title: varchar('track_title', { length: 128 }),
});

export type NewShow = InferModel<typeof shows, 'insert'>;
export type Show = InferModel<typeof shows, 'select'>;
export const shows = wxyc_schema.table('shows', {
  id: serial('id').primaryKey(),
  dj_id: integer('dj_id')
    .references(() => djs.id)
    .notNull(),
  dj_id2: integer('dj_id2').references(() => djs.id),
  dj_id3: integer('dj_id3').references(() => djs.id),
  specialty_id: integer('specialty_id') //Null for regular shows
    .references(() => specialty_shows.id),
  show_name: varchar('show_name', { length: 128 }), //Null if not provided or specialty show
  start_time: timestamp('start_time').defaultNow().notNull(),
  end_time: timestamp('end_time'),
});

//create entry w/ ID 0 for regular shows
export type NewSpecialtyShow = InferModel<typeof specialty_shows, 'insert'>;
export type SpecialtyShows = InferModel<typeof specialty_shows, 'select'>;
export const specialty_shows = wxyc_schema.table('specialty_shows', {
  id: serial('id').primaryKey(),
  specialty_name: varchar('specialty_name', { length: 64 }).notNull(),
  description: text('description'),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});

export const library_artist_view = wxyc_schema.view('library_artist_view').as((qb) => {
  return qb
    .select({
      library_id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: artists.code_artist_number,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      album_title: library.album_title,
      format_name: format.format_name,
      genre_name: genres.genre_name,
      rotation: rotation.play_freq,
      add_date: library.add_date,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .leftJoin(
      rotation,
      sql`${rotation.album_id} = ${library.id} AND (${rotation.kill_date} < CURRENT_DATE OR ${rotation.kill_date} IS NULL)`
    );
});

export const rotation_library_view = wxyc_schema.view('rotation_library_view').as((qb) => {
  return qb
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
    .innerJoin(artists, eq(artists.id, library.artist_id));
});
