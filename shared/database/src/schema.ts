import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { sql, eq, and } from 'drizzle-orm';
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
  customType,
  real,
} from 'drizzle-orm/pg-core';

// PostgreSQL tsvector. Drizzle has no first-class tsvector type, but we only
// reference these columns from raw SQL fragments (WHERE search_doc @@ ...),
// so the in-TS data type does not matter — what matters is the dataType()
// returned to drizzle-kit so generated migrations / schema diffs use the
// right SQL type name.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

// Schema name is configurable for parallel test isolation (each Jest worker gets its own schema)
const WXYC_SCHEMA_NAME = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
export const wxyc_schema = pgSchema(WXYC_SCHEMA_NAME);

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
    isAnonymous: boolean('is_anonymous').notNull().default(false),
    hasCompletedOnboarding: boolean('has_completed_onboarding').notNull().default(false),
    // Cross-cutting capabilities independent of role hierarchy (e.g., 'editor', 'webmaster')
    capabilities: text('capabilities').array().notNull().default([]),
  },
  (table) => [
    uniqueIndex('auth_user_email_key').on(table.email),
    uniqueIndex('auth_user_username_key').on(table.username),
    index('auth_user_dj_name_trgm_idx').using('gin', sql`${table.djName} gin_trgm_ops`),
    index('auth_user_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  ]
);

export type User = InferSelectModel<typeof user>;
export type NewUser = InferInsertModel<typeof user>;

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
  (table) => [uniqueIndex('auth_session_token_key').on(table.token)]
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
  (table) => [uniqueIndex('auth_account_provider_account_key').on(table.providerId, table.accountId)]
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
  (table) => [uniqueIndex('auth_organization_slug_key').on(table.slug)]
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
  (table) => [uniqueIndex('auth_member_org_user_key').on(table.organizationId, table.userId)]
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
  (table) => [index('auth_invitation_email_idx').on(table.email)]
);

export type NewDJStats = InferInsertModel<typeof dj_stats>;
export type DJStats = InferSelectModel<typeof dj_stats>;
export const dj_stats = wxyc_schema.table('dj_stats', {
  user_id: varchar('user_id', { length: 255 })
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  shows_covered: smallint('shows_covered').default(0).notNull(),
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
  specialty_id: integer('specialty_id').references(() => specialty_shows.id, { onDelete: 'set null' }), //null for regular shows
  assigned_dj_id: varchar('assigned_dj_id', { length: 255 }).references(() => user.id, { onDelete: 'set null' }),
  assigned_dj_id2: varchar('assigned_dj_id2', { length: 255 }).references(() => user.id, { onDelete: 'set null' }),
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
  shift_timestamp: timestamp('shift_timestamp', { withTimezone: true }).notNull(), //Timestamp to expire cover requests
  cover_dj_id: varchar('cover_dj_id', { length: 255 }).references(() => user.id, { onDelete: 'set null' }),
  covered: boolean('covered').default(false),
});

export type NewCronjobRun = InferInsertModel<typeof cronjob_runs>;
export type CronjobRun = InferSelectModel<typeof cronjob_runs>;
export const cronjob_runs = wxyc_schema.table('cronjob_runs', {
  job_name: varchar('job_name', { length: 64 }).primaryKey(),
  last_run: timestamp('last_run', { withTimezone: true }).notNull().defaultNow(),
});

export type NewArtist = InferInsertModel<typeof artists>;
export type Artist = InferSelectModel<typeof artists>;
export const artists = wxyc_schema.table(
  'artists',
  {
    id: serial('id').primaryKey(),
    artist_name: varchar('artist_name', { length: 128 }).notNull(),
    alphabetical_name: varchar('alphabetical_name', { length: 128 }).notNull(),
    code_letters: varchar('code_letters', { length: 4 }).notNull(),
    add_date: date('add_date').defaultNow().notNull(),
    last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
    // Reconciled external identifiers, populated by an ETL from LML's entity.identity table.
    // Mirrors the @wxyc/shared ReconciledIdentity schema. All nullable; URL construction is
    // the consumer's responsibility (templates exist for Spotify, Apple Music, and Bandcamp).
    discogs_artist_id: integer('discogs_artist_id'),
    musicbrainz_artist_id: varchar('musicbrainz_artist_id', { length: 64 }),
    wikidata_qid: varchar('wikidata_qid', { length: 32 }),
    spotify_artist_id: varchar('spotify_artist_id', { length: 64 }),
    apple_music_artist_id: varchar('apple_music_artist_id', { length: 64 }),
    bandcamp_id: varchar('bandcamp_id', { length: 255 }),
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
    album_artist: varchar('album_artist', { length: 128 }),
    album_title: varchar('album_title', { length: 128 }).notNull(),
    label: varchar('label', { length: 128 }),
    label_id: integer('label_id').references(() => labels.id),
    code_number: smallint('code_number').notNull(),
    code_volume_letters: varchar('code_volume_letters', { length: 4 }),
    disc_quantity: smallint('disc_quantity').default(1).notNull(),
    plays: integer('plays').default(0).notNull(),
    legacy_release_id: integer('legacy_release_id'),
    add_date: timestamp('add_date', { withTimezone: true }).defaultNow().notNull(),
    last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
    date_lost: timestamp('date_lost', { withTimezone: true }),
    date_found: timestamp('date_found', { withTimezone: true }),
    on_streaming: boolean('on_streaming'),
    artwork_url: varchar('artwork_url', { length: 512 }),
    // Denormalized from artists.artist_name (Epic A.1). Nullable until A.2
    // backfills it from the artists join; A.3 keeps it current on insert and
    // cascades on artists UPDATE. A.5 reads it via search_doc.
    artist_name: varchar('artist_name', { length: 128 }),
    // Reconciled canonical entity for the album, derived via LML lookup
    // (Epic B.1). Nullable until B-1.2 backfills it; B-1.3 keeps it current
    // on insert. The identifier is opaque text (e.g. a Discogs/MusicBrainz
    // release id, optionally namespaced) — schemes are decided per-source by
    // the resolver, not the column. Confidence is captured at link time so
    // retroactive analyses can re-judge weak matches; resolved_at supports
    // audit + retry policy. The B-tree index supports flowsheet → library
    // joins via canonical entity in B-2.
    canonical_entity_id: text('canonical_entity_id'),
    canonical_entity_confidence: real('canonical_entity_confidence'),
    canonical_entity_resolved_at: timestamp('canonical_entity_resolved_at', { withTimezone: true }),
    // STORED GENERATED tsvector covering the searchable text fields with
    // weight bands (artist=A, album=B). NULL for rows where artist_name has
    // not been backfilled yet — A.2 populates legacy rows, A.3 keeps live
    // writes current. Read by the new tsvector search path in A.5.
    search_doc: tsvector('search_doc').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') || setweight(to_tsvector('simple', coalesce("album_title", '')), 'B')`
    ),
  },
  (table) => {
    return {
      titleTrgmIdx: index('title_trgm_idx').using(`gin`, sql`${table.album_title} gin_trgm_ops`),
      genreIdIdx: index('genre_id_idx').on(table.genre_id),
      formatIdIdx: index('format_id_idx').on(table.format_id),
      artistIdIdx: index('artist_id_idx').on(table.artist_id),
      legacyReleaseIdIdx: uniqueIndex('library_legacy_release_id_idx').on(table.legacy_release_id),
      albumArtistTrgmIdx: index('album_artist_trgm_idx').using(`gin`, sql`${table.album_artist} gin_trgm_ops`),
      libraryArtistNameTrgmIdx: index('library_artist_name_trgm_idx').using(
        `gin`,
        sql`${table.artist_name} gin_trgm_ops`
      ),
      librarySearchDocIdx: index('library_search_doc_idx').using('gin', sql`${table.search_doc}`),
      libraryCanonicalEntityIdIdx: index('library_canonical_entity_id_idx').on(table.canonical_entity_id),
    };
  }
);

export type NewCompilationTrackArtist = InferInsertModel<typeof compilation_track_artist>;
export type CompilationTrackArtist = InferSelectModel<typeof compilation_track_artist>;
export const compilation_track_artist = wxyc_schema.table(
  'compilation_track_artist',
  {
    id: serial('id').primaryKey(),
    library_id: integer('library_id')
      .notNull()
      .references(() => library.id, { onDelete: 'cascade' }),
    artist_name: varchar('artist_name', { length: 255 }).notNull(),
    track_title: varchar('track_title', { length: 255 }),
    track_position: varchar('track_position', { length: 20 }),
  },
  (table) => [
    index('cta_library_id_idx').on(table.library_id),
    index('cta_artist_name_idx').on(table.artist_name),
    uniqueIndex('cta_unique_idx').on(table.library_id, table.artist_name, table.track_title),
  ]
);

export type NewRotationRelease = InferInsertModel<typeof rotation>;
export type RotationRelease = InferSelectModel<typeof rotation>;
export const freqEnum = pgEnum('freq_enum', ['S', 'L', 'M', 'H', 'N']);

export const flowsheetEntryTypeEnum = wxyc_schema.enum('flowsheet_entry_type', [
  'track',
  'show_start',
  'show_end',
  'dj_join',
  'dj_leave',
  'talkset',
  'breakpoint',
  'message',
]);
export const rotation = wxyc_schema.table(
  'rotation',
  {
    id: serial('id').primaryKey(),
    album_id: integer('album_id').references(() => library.id, { onDelete: 'cascade' }),
    legacy_rotation_id: integer('legacy_rotation_id'),
    legacy_library_release_id: integer('legacy_library_release_id'),
    rotation_bin: freqEnum('rotation_bin').notNull(),
    add_date: date('add_date').defaultNow().notNull(),
    kill_date: date('kill_date'),
    artist_name: varchar('artist_name', { length: 128 }),
    album_title: varchar('album_title', { length: 128 }),
    record_label: varchar('record_label', { length: 128 }),
  },
  (table) => {
    return {
      albumIdIdx: index('album_id_idx').on(table.album_id),
      legacyRotationIdIdx: uniqueIndex('rotation_legacy_rotation_id_idx').on(table.legacy_rotation_id),
    };
  }
);

export type NewFSEntry = InferInsertModel<typeof flowsheet>;
export type FSEntry = InferSelectModel<typeof flowsheet>;
export const flowsheet = wxyc_schema.table(
  'flowsheet',
  {
    id: serial('id').primaryKey(),
    show_id: integer('show_id').references(() => shows.id, { onDelete: 'set null' }),
    album_id: integer('album_id').references(() => library.id, { onDelete: 'set null' }),
    rotation_id: integer('rotation_id').references(() => rotation.id, { onDelete: 'set null' }),
    legacy_entry_id: integer('legacy_entry_id'),
    legacy_release_id: integer('legacy_release_id'),
    entry_type: flowsheetEntryTypeEnum('entry_type').notNull().default('track'),
    track_title: varchar('track_title', { length: 128 }),
    album_title: varchar('album_title', { length: 128 }),
    artist_name: varchar('artist_name', { length: 128 }),
    record_label: varchar('record_label', { length: 128 }),
    label_id: integer('label_id').references(() => labels.id),
    play_order: integer('play_order').notNull(),
    request_flag: boolean('request_flag').default(false).notNull(),
    segue: boolean('segue').default(false).notNull(),
    message: varchar('message', { length: 250 }),
    add_time: timestamp('add_time', { withTimezone: true }).defaultNow().notNull(),
    // Metadata (fetched from LML on insert, stored inline)
    artwork_url: varchar('artwork_url', { length: 512 }),
    discogs_url: varchar('discogs_url', { length: 512 }),
    release_year: smallint('release_year'),
    spotify_url: varchar('spotify_url', { length: 512 }),
    apple_music_url: varchar('apple_music_url', { length: 512 }),
    youtube_music_url: varchar('youtube_music_url', { length: 512 }),
    bandcamp_url: varchar('bandcamp_url', { length: 512 }),
    soundcloud_url: varchar('soundcloud_url', { length: 512 }),
    artist_bio: text('artist_bio'),
    artist_wikipedia_url: varchar('artist_wikipedia_url', { length: 512 }),
    // Resolved DJ name denormalized from shows/auth_user at insert time
    // (step 5b). Backfilled by migration 0053; populated on write by the
    // ETL job and the live insert controller from step 5b.2 onward.
    dj_name: text('dj_name'),
    // Linkage audit (B-1.4). Records how `album_id` was resolved on this
    // row so we can audit match quality, undo a class of bad matches if a
    // heuristic regresses, and weight differently in ranking. Setting
    // these on new linkages is handled in B-2.1 / B-2.2 / B-3.1; this
    // migration only adds the columns nullable. Source values are
    // enum-like text: 'etl_legacy_id' | 'dj_bin_pick' | 'lml_high_confidence'
    // | 'human_review' | 'tubafrenzy_mirror'.
    linkage_source: text('linkage_source'),
    linkage_confidence: real('linkage_confidence'),
    linked_at: timestamp('linked_at', { withTimezone: true }),
    // B-0.5 marker: timestamp set when the legacy_release_id → library.id
    // resolver ran for this row and could not link. Lets B-2.2's LML
    // backfill find the broken-FK residual alongside the rows that never
    // had a legacy_release_id at all. NULL means "either already linked,
    // or the FK resolver hasn't run yet". See migration 0063 +
    // jobs/broken-fk-recovery for the population pass.
    legacy_link_attempted_at: timestamp('legacy_link_attempted_at', { withTimezone: true }),
    // STORED GENERATED tsvector covering the searchable text fields with
    // weight bands (artist=A, track+dj=B, album=C, label=D). Managed by
    // migration 0054 (which extended the original 0052 expression to include
    // dj_name); declared here so drizzle-kit drift detection treats it as
    // present rather than proposing to add it.
    search_doc: tsvector('search_doc').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') || setweight(to_tsvector('simple', coalesce("track_title", '')), 'B') || setweight(to_tsvector('simple', coalesce("dj_name", '')), 'B') || setweight(to_tsvector('simple', coalesce("album_title", '')), 'C') || setweight(to_tsvector('simple', coalesce("record_label", '')), 'D')`
    ),
  },
  (table) => [
    uniqueIndex('flowsheet_legacy_entry_id_idx').on(table.legacy_entry_id),
    index('flowsheet_legacy_release_id_idx').on(table.legacy_release_id),
    index('flowsheet_artist_name_trgm_idx').using('gin', sql`${table.artist_name} gin_trgm_ops`),
    index('flowsheet_track_title_trgm_idx').using('gin', sql`${table.track_title} gin_trgm_ops`),
    index('flowsheet_album_title_trgm_idx').using('gin', sql`${table.album_title} gin_trgm_ops`),
    index('flowsheet_record_label_trgm_idx').using('gin', sql`${table.record_label} gin_trgm_ops`),
    index('flowsheet_dj_name_trgm_idx').using('gin', sql`${table.dj_name} gin_trgm_ops`),
    index('flowsheet_track_add_time_idx')
      .on(sql`${table.add_time} DESC`)
      .where(sql`${table.entry_type} = 'track'`),
    index('flowsheet_search_doc_idx').using('gin', sql`${table.search_doc}`),
    // Functional partial index that supports the playlist-proxy artwork
    // lookup. Mirrors `flowsheetLookupKey` in
    // apps/backend/services/playlist-proxy.service.ts. Partial because only
    // ~5-10% of rows have non-null artwork — the others would be index
    // dead weight.
    index('flowsheet_artwork_lookup_idx')
      .on(sql`(lower(trim(${table.artist_name})) || '-' || lower(trim(coalesce(${table.album_title}, ''))))`)
      .where(sql`${table.artwork_url} IS NOT NULL`),
  ]
);

export type NewGenre = InferInsertModel<typeof genres>;
export type Genre = InferSelectModel<typeof genres>;
export const genres = wxyc_schema.table('genres', {
  id: serial('id').primaryKey(),
  genre_name: varchar('genre_name', { length: 64 }).notNull(),
  description: text('description'),
  plays: integer('plays').default(0).notNull(),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
});

export type NewLabel = InferInsertModel<typeof labels>;
export type Label = InferSelectModel<typeof labels>;
export const labels = wxyc_schema.table('labels', {
  id: serial('id').primaryKey(),
  label_name: varchar('label_name', { length: 128 }).notNull().unique(),
  parent_label_id: integer('parent_label_id'),
});

export type NewReview = InferInsertModel<typeof reviews>;
export type Review = InferSelectModel<typeof reviews>;
export const reviews = wxyc_schema.table('reviews', {
  id: serial('id').primaryKey(),
  album_id: integer('album_id')
    .references(() => library.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  review: text('review'),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
  author: varchar('author', { length: 32 }),
});

export type NewBinEntry = InferInsertModel<typeof bins>;
export type BinEntry = InferSelectModel<typeof bins>;
export const bins = wxyc_schema.table('bins', {
  id: serial('id').primaryKey(),
  dj_id: varchar('dj_id', { length: 255 })
    .references(() => user.id, { onDelete: 'cascade' })
    .notNull(),
  album_id: integer('album_id')
    .references(() => library.id)
    .notNull(),
  track_title: varchar('track_title', { length: 128 }),
});

export type NewGenreArtistCrossreference = InferInsertModel<typeof genre_artist_crossreference>;
export type GenreArtistCrossreference = InferSelectModel<typeof genre_artist_crossreference>;
export const genre_artist_crossreference = wxyc_schema.table(
  'genre_artist_crossreference',
  {
    artist_id: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    genre_id: integer('genre_id')
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
    artist_genre_code: integer('artist_genre_code').notNull(),
  },
  (table) => [uniqueIndex('artist_genre_key').on(table.artist_id, table.genre_id)]
);

export type NewArtistLibraryCrossreference = InferInsertModel<typeof artist_library_crossreference>;
export type ArtistLibraryCrossreference = InferSelectModel<typeof artist_library_crossreference>;
export const artist_library_crossreference = wxyc_schema.table(
  'artist_library_crossreference',
  {
    artist_id: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    library_id: integer('library_id')
      .notNull()
      .references(() => library.id, { onDelete: 'cascade' }),
    comment: varchar('comment', { length: 255 }),
  },
  (table) => [uniqueIndex('library_id_artist_id').on(table.artist_id, table.library_id)]
);

export type NewArtistCrossreference = InferInsertModel<typeof artist_crossreference>;
export type ArtistCrossreference = InferSelectModel<typeof artist_crossreference>;
export const artist_crossreference = wxyc_schema.table(
  'artist_crossreference',
  {
    source_artist_id: integer('source_artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    target_artist_id: integer('target_artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    comment: varchar('comment', { length: 255 }),
  },
  (table) => [uniqueIndex('artist_crossref_source_target').on(table.source_artist_id, table.target_artist_id)]
);

export type NewShow = InferInsertModel<typeof shows>;
export type Show = InferSelectModel<typeof shows>;
export const shows = wxyc_schema.table(
  'shows',
  {
    id: serial('id').primaryKey(),
    primary_dj_id: varchar('primary_dj_id', { length: 255 }).references(() => user.id, { onDelete: 'set null' }),
    specialty_id: integer('specialty_id').references(() => specialty_shows.id),
    legacy_show_id: integer('legacy_show_id'),
    legacy_dj_name: varchar('legacy_dj_name', { length: 128 }),
    legacy_dj_id: integer('legacy_dj_id'),
    show_name: varchar('show_name', { length: 128 }),
    start_time: timestamp('start_time', { withTimezone: true }).defaultNow().notNull(),
    end_time: timestamp('end_time', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('shows_legacy_show_id_idx').on(table.legacy_show_id),
    index('shows_legacy_dj_name_trgm_idx').using('gin', sql`${table.legacy_dj_name} gin_trgm_ops`),
  ]
);

export type NewShowDJ = InferInsertModel<typeof show_djs>;
export type ShowDJ = InferSelectModel<typeof show_djs>;
export const show_djs = wxyc_schema.table(
  'show_djs',
  {
    show_id: integer('show_id')
      .references(() => shows.id, { onDelete: 'cascade' })
      .notNull(),
    dj_id: varchar('dj_id', { length: 255 })
      .references(() => user.id, { onDelete: 'cascade' })
      .notNull(),
    active: boolean('active').default(true),
  },
  (table) => [uniqueIndex('show_djs_show_id_dj_id_unique').on(table.show_id, table.dj_id)]
);

//create entry w/ ID 0 for regular shows
export type NewSpecialtyShow = InferInsertModel<typeof specialty_shows>;
export type SpecialtyShows = InferSelectModel<typeof specialty_shows>;
export const specialty_shows = wxyc_schema.table('specialty_shows', {
  id: serial('id').primaryKey(),
  specialty_name: varchar('specialty_name', { length: 64 }).notNull(),
  description: text('description'),
  add_date: date('add_date').defaultNow().notNull(),
  last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
});

export const library_artist_view = wxyc_schema.view('library_artist_view').as((qb) => {
  return qb
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: genre_artist_crossreference.artist_genre_code,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      alphabetical_name: artists.alphabetical_name,
      album_title: library.album_title,
      format_name: format.format_name,
      genre_name: genres.genre_name,
      rotation_bin: rotation.rotation_bin,
      add_date: library.add_date,
      label: library.label,
      label_id: library.label_id,
      on_streaming: library.on_streaming,
      album_artist: library.album_artist,
      plays: library.plays,
      artwork_url: library.artwork_url,
      discogs_artist_id: artists.discogs_artist_id,
      musicbrainz_artist_id: artists.musicbrainz_artist_id,
      wikidata_qid: artists.wikidata_qid,
      spotify_artist_id: artists.spotify_artist_id,
      apple_music_artist_id: artists.apple_music_artist_id,
      bandcamp_id: artists.bandcamp_id,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .leftJoin(
      rotation,
      sql`${rotation.album_id} = ${library.id} AND (${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL)`
    );
});
export type LibraryArtistViewEntry = {
  id: number;
  code_letters: string;
  code_artist_number: number;
  code_number: number;
  artist_name: string;
  alphabetical_name: string;
  album_title: string;
  format_name: string;
  genre_name: string;
  rotation_bin: string | null;
  add_date: Date;
  label: string | null;
  label_id: number | null;
  on_streaming: boolean | null;
  album_artist: string | null;
  plays: number;
  artwork_url: string | null;
  discogs_artist_id: number | null;
  musicbrainz_artist_id: string | null;
  wikidata_qid: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
};

// Per-album play count, aggregated from `flowsheet` track entries. The MV is
// created and indexed by migration 0059, refreshed periodically by
// `apps/backend/services/album-plays-refresh.service.ts`. Declared with
// `.existing()` because we own the SQL via the migration; this entry exists
// so drizzle-kit drift detection treats the MV as known and so the search
// service can reference its columns through Drizzle.
export const album_plays = wxyc_schema
  .materializedView('album_plays', {
    album_id: integer('album_id').notNull(),
    plays: integer('plays').notNull(),
  })
  .existing();

export const rotation_library_view = wxyc_schema.view('rotation_library_view').as((qb) => {
  return qb
    .select({
      library_id: library.id,
      rotation_id: rotation.id,
      label: library.label,
      label_id: library.label_id,
      rotation_bin: rotation.rotation_bin,
      album_title: library.album_title,
      artist_name: artists.artist_name,
      alphabetical_name: artists.alphabetical_name,
      kill_date: rotation.kill_date,
    })
    .from(library)
    .innerJoin(rotation, eq(library.id, rotation.album_id))
    .innerJoin(artists, eq(artists.id, library.artist_id));
});

// User activity tracking (for anonymous users)
export const user_activity = pgTable('user_activity', {
  userId: varchar('user_id', { length: 255 })
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  requestCount: integer('request_count').notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserActivity = InferSelectModel<typeof user_activity>;
export type NewUserActivity = InferInsertModel<typeof user_activity>;

// Anonymous device tracking for song requests (legacy - to be deprecated)
export const anonymous_devices = pgTable(
  'anonymous_devices',
  {
    id: serial('id').primaryKey(),
    deviceId: varchar('device_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    blocked: boolean('blocked').notNull().default(false),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    blockedReason: text('blocked_reason'),
    requestCount: integer('request_count').notNull().default(0),
  },
  (table) => [uniqueIndex('anonymous_devices_device_id_key').on(table.deviceId)]
);

export type AnonymousDevice = InferSelectModel<typeof anonymous_devices>;
export type NewAnonymousDevice = InferInsertModel<typeof anonymous_devices>;
