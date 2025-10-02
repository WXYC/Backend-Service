import { InferInsertModel, InferSelectModel, sql, eq } from 'drizzle-orm';
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
  date
} from 'drizzle-orm/pg-core';

export const wxyc_schema = pgSchema('wxyc_schema');

// ---- Better Auth schema ----
export const user = wxyc_schema.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  realName: text("real_name"),
  djName: text("dj_name"),
  appSkin: text("app_skin").notNull(),
});

export const session = wxyc_schema.table("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
  activeOrganizationId: text("active_organization_id"),
});

export const account = wxyc_schema.table("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const verification = wxyc_schema.table("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const jwks = wxyc_schema.table("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

// ---- Organization Plugin Schema ----

export const organization = wxyc_schema.table("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
});

export const member = wxyc_schema.table("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

export const invitation = wxyc_schema.table("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// ---- WXYC schema ----

export type NewShift = InferInsertModel<typeof schedule>;
export type Shift = InferSelectModel<typeof schedule>;
// days {0: mon, 1: tue, ... , 6: sun}
// date n shows from now can be found with query:

export const schedule = wxyc_schema.table('schedule', {
  id: serial('id').primaryKey(),
  day: smallint('day').notNull(),
  start_time: time('start_time').notNull(),
  show_duration: smallint('show_duration').notNull(), // In 15-minute blocs
  specialty_id: integer('specialty_id').references(() => specialty_shows.id), //null for regular shows
  assigned_dj_id: varchar('assigned_dj_id', { length: 255 }).references(() => user.id),
  assigned_dj_id2: varchar('assigned_dj_id2', { length: 255 }).references(() => user.id),
});

//SELECT date_trunc('week', current_timestamp + timestamp '${n} weeks') + interval '${schedule.day} days' + ${schedule.time}
//or really it could be done client side really easily...
export type NewShiftCover = InferInsertModel<typeof shift_covers>;
export type ShiftCover = InferSelectModel<typeof shift_covers>;
export const shift_covers = wxyc_schema.table('shift_covers', {
  id: serial('id').primaryKey(),
  schedule_id: integer('schedule_id')
    .references(() => schedule.id)
    .notNull(),
  shift_timestamp: timestamp('shift_timestamp').notNull(), //Timestamp to expire cover requests
  cover_dj_id: varchar('cover_dj_id', { length: 255 }).references(() => user.id),
  covered: boolean('covered').default(false),
});

export type NewArtist = InferInsertModel<typeof artists>;
export type Artist = InferSelectModel<typeof artists>;
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
      artistNameTrgmIdx: index('artist_name_trgm_idx').using(`gin`, sql`${table.artist_name} gin_trgm_ops`),
      codeLettersIdx: index('code_letters_idx').on(table.code_letters),
    };
  }
);

export type NewAlbumFormat = InferInsertModel<typeof format>;
export type AlbumFormat = InferSelectModel<typeof format>;
//cd, cdr, vinyl, vinyl - 7", vinyl - 12", 'vinyl - LP'
export const format = wxyc_schema.table('format', {
  id: serial('id').primaryKey(),
  format_name: varchar('format_name').notNull(),
  date_added: date('add_date').defaultNow().notNull(),
});

export type NewAlbum = InferInsertModel<typeof library>;
export type Album = InferSelectModel<typeof library>;
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
      titleTrgmIdx: index('title_trgm_idx').using(`gin`, sql`${table.album_title} gin_trgm_ops`),
      genreIdIdx: index('genre_id_idx').on(table.genre_id),
      formatIdIdx: index('format_id_idx').on(table.format_id),
      artistIdIdx: index('artist_id_idx').on(table.artist_id),
    };
  }
);

export type NewRotationRelease = InferInsertModel<typeof rotation>;
export type RotationRelease = InferSelectModel<typeof rotation>;
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

export type NewFSEntry = InferInsertModel<typeof flowsheet>;
export type FSEntry = InferSelectModel<typeof flowsheet>;
export const flowsheet = wxyc_schema.table('flowsheet', {
  id: serial('id').primaryKey(),
  show_id: integer('show_id').references(() => shows.id),
  album_id: integer('album_id').references(() => library.id),
  rotation_id: integer('rotation_id').references(() => rotation.id),
  track_title: varchar('track_title', { length: 128 }),
  album_title: varchar('album_title', { length: 128 }),
  artist_name: varchar('artist_name', { length: 128 }),
  record_label: varchar('record_label', { length: 128 }),
  play_order: integer('play_order').notNull(),
  request_flag: boolean('request_flag').default(false).notNull(),
  message: varchar('message', { length: 250 }),
  add_time: timestamp('add_time').defaultNow().notNull(),
});

export type NewGenre = InferInsertModel<typeof genres>;
export type Genre = InferSelectModel<typeof genres>;
export const genres = wxyc_schema.table('genres', {
  id: serial('id').primaryKey(),
  genre_name: varchar('genre_name', { length: 64 }).notNull(),
  description: text('description'),
  plays: integer('plays').default(0).notNull(),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});

export type NewReview = InferInsertModel<typeof reviews>;
export type Review = InferSelectModel<typeof reviews>;
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

export type NewBinEntry = InferInsertModel<typeof bins>;
export type BinEntry = InferSelectModel<typeof bins>;
export const bins = wxyc_schema.table('bins', {
  id: serial('id').primaryKey(),
  dj_id: varchar('dj_id', { length: 255 })
    .references(() => user.id)
    .notNull(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(),
  track_title: varchar('track_title', { length: 128 }),
});

export type NewShow = InferInsertModel<typeof shows>;
export type Show = InferSelectModel<typeof shows>;
export const shows = wxyc_schema.table('shows', {
  id: serial('id').primaryKey(),
  primary_dj_id: varchar('primary_dj_id', { length: 255 }).references(() => user.id),
  specialty_id: integer('specialty_id') //Null for regular shows
    .references(() => specialty_shows.id),
  show_name: varchar('show_name', { length: 128 }), //Null if not provided or specialty show
  start_time: timestamp('start_time').defaultNow().notNull(),
  end_time: timestamp('end_time'),
});

export type NewShowDJ = InferInsertModel<typeof show_djs>;
export type ShowDJ = InferSelectModel<typeof show_djs>;
export const show_djs = wxyc_schema.table('show_djs', {
  show_id: integer('show_id')
    .references(() => shows.id)
    .notNull(),
  dj_id: varchar('dj_id', { length: 255 })
    .references(() => user.id)
    .notNull(),
  active: boolean('active').default(true),
});

//create entry w/ ID 0 for regular shows
export type NewSpecialtyShow = InferInsertModel<typeof specialty_shows>;
export type SpecialtyShows = InferSelectModel<typeof specialty_shows>;
export const specialty_shows = wxyc_schema.table('specialty_shows', {
  id: serial('id').primaryKey(),
  specialty_name: varchar('specialty_name', { length: 64 }).notNull(),
  description: text('description'),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified').defaultNow().notNull(),
});

export type LibraryArtistViewEntry = {
  id: number;
  code_letters: string;
  code_artist_number: number;
  code_number: number;
  artist_name: string;
  album_title: string;
  format_name: string;
  genre_name: string;
  play_freq: string | null;
  add_date: Date;
  label: string | null;
};
export const library_artist_view = wxyc_schema.view('library_artist_view').as((qb) => {
  return qb
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: artists.code_artist_number,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      album_title: library.album_title,
      format_name: format.format_name,
      genre_name: genres.genre_name,
      play_freq: rotation.play_freq,
      add_date: library.add_date,
      label: library.label,
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
