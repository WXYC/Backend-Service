import { InferInsertModel, InferSelectModel, sql, eq } from 'drizzle-orm';
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
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const wxyc_schema = pgSchema('wxyc_schema');

export const user = pgTable(
  'auth_user',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    role: varchar('role', { length: 255 }),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),
    username: varchar('username', { length: 255 }),
    displayUsername: varchar('display_username', { length: 255 }),
    realName: varchar('real_name', { length: 255 }),
    djName: varchar('dj_name', { length: 255 }),
    appSkin: varchar('app_skin', { length: 255 }).notNull().default('modern-light'),
  },
  (table) => [
    uniqueIndex('auth_user_email_key').on(table.email),
    uniqueIndex('auth_user_username_key').on(table.username),
  ]
);

export const session = pgTable(
  'auth_session',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    userId: varchar('user_id', { length: 255 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: varchar('token', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: varchar('ip_address', { length: 255 }),
    userAgent: text('user_agent'),
    impersonatedBy: varchar('impersonated_by', { length: 255 }),
    activeOrganizationId: varchar('active_organization_id', { length: 255 }),
  },
  (table) => [
    uniqueIndex('auth_session_token_key').on(table.token),
  ]
);

export const account = pgTable(
  'auth_account',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    userId: varchar('user_id', { length: 255 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: varchar('scope', { length: 255 }),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_account_provider_account_key').on(
      table.providerId,
      table.accountId
    ),
  ]
);

export const verification = pgTable('auth_verification', {
  id: varchar('id', { length: 255 }).primaryKey(),
  identifier: varchar('identifier', { length: 255 }).notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jwks = pgTable('auth_jwks', {
  id: varchar('id', { length: 255 }).primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organization = pgTable(
  'auth_organization',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull(),
    logo: text('logo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: text('metadata'),
  },
  (table) => [
    uniqueIndex('auth_organization_slug_key').on(table.slug),
  ]
);

export const member = pgTable(
  'auth_member',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 })
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 255 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 255 }).notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_member_org_user_key').on(table.organizationId, table.userId),
  ]
);

export const invitation = pgTable(
  'auth_invitation',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 })
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 255 }),
    status: varchar('status', { length: 255 }).notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    inviterId: varchar('inviter_id', { length: 255 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_invitation_email_idx').on(table.email),
  ]
);

export type NewDJ = InferInsertModel<typeof djs>;
export type DJ = InferSelectModel<typeof djs>;
export const djs = wxyc_schema.table('djs', {
  id: serial('id').primaryKey(),
  cognito_user_name: varchar('cognito_user_name').notNull().unique(),
  real_name: varchar('real_name'),
  dj_name: varchar('dj_name'),
  shows_covered: smallint('shows_covered').default(0).notNull(),
  add_date: date('add_date').defaultNow().notNull(),
});

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
  assigned_dj_id: integer('assigned_dj_id').references(() => djs.id),
  assigned_dj_id2: integer('assigned_dj_id2').references(() => djs.id),
});

//SELECT date_trunc('week', current_timestamp + timestamp '${n} weeks') + interval '${schedule.day} days' + ${schedule.time}
//or really it could be done client side really easily...
export type NewShiftCover = InferInsertModel<typeof shift_covers>;
export type ShiftCover = InferSelectModel<typeof shift_covers>;
export const shift_covers = wxyc_schema.table('shift_covers', {
  id: serial('id').primaryKey(),
  schedule_id: serial('schedule_id')
    .references(() => schedule.id)
    .notNull(),
  shift_timestamp: timestamp('shift_timestamp').notNull(), //Timestamp to expire cover requests
  cover_dj_id: integer('cover_dj_id').references(() => djs.id),
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
  play_order: serial('play_order').notNull(),
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
  dj_id: integer('dj_id')
    .references(() => djs.id)
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
  primary_dj_id: integer('primary_dj_id').references(() => djs.id),
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
  dj_id: integer('dj_id')
    .references(() => djs.id)
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
