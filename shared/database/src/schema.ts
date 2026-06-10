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
  uuid,
  primaryKey,
  check,
  jsonb,
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

// BS#1261. Request-line ban surface. Ban-target is the stable iOS-generated
// UUIDv4 in iCloud Keychain (separate item from AuthSession), sent on every
// `POST /request` to ROM and on `/sign-in/anonymous`. Per-fingerprint rather
// than per-`user.id` because better-auth anonymous re-sign-in mints a fresh
// `user.id`, so a `user.banned`-only ban is one tap away from evasion. The
// fingerprint survives anonymous re-sign-in and reinstall on the same Apple
// ID; a deliberate attacker disabling iCloud Keychain + reinstalling still
// gets a fresh value, which is the accepted limitation.
//
// `banned_by_user_id` is nullable to permit Slack-actor bans (no
// corresponding better-auth user). `ON DELETE SET NULL` so deleting an
// operator account doesn't cascade-delete ban history.
//
// Partial index on `ban_expires_at` covers the temporary-ban tail; the
// permanent rows (NULL `ban_expires_at`) are the common case and don't need
// the index. The check-request-ban handler treats `ban_expires_at < now()`
// as not-banned without deleting the row (cleanup is a separate concern).
export type NewBannedFingerprint = InferInsertModel<typeof banned_fingerprints>;
export type BannedFingerprint = InferSelectModel<typeof banned_fingerprints>;
export const banned_fingerprints = wxyc_schema.table(
  'banned_fingerprints',
  {
    fingerprint: uuid('fingerprint').primaryKey(),
    banned_at: timestamp('banned_at', { withTimezone: true }).notNull().defaultNow(),
    ban_reason: text('ban_reason').notNull(),
    ban_expires_at: timestamp('ban_expires_at', { withTimezone: true }),
    banned_by_user_id: varchar('banned_by_user_id', { length: 255 }).references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('banned_fingerprints_ban_expires_at_idx')
      .on(table.ban_expires_at)
      .where(sql`${table.ban_expires_at} IS NOT NULL`),
  ]
);

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
    /**
     * SOURCE: LML's `entity.identity` PostgreSQL table via
     * `jobs/artist-identity-etl/`. Library staff own everything else on
     * this row; the six reconciled-identity columns below are populated
     * (null-fill only) by the LML ETL. Shapes LML permits and the ETL
     * preserves:
     *
     *   - All six are nullable. LML resolves identifiers per source
     *     independently; an artist can have a Discogs match but no
     *     MusicBrainz match, etc. Do NOT add NOT NULL or any composite
     *     uniqueness across these columns.
     *   - Library-staff-entered values win on conflict (the ETL only
     *     null-fills); a non-null value here is the authoritative one
     *     even if it differs from LML's current resolution.
     *   - URL construction is the consumer's responsibility (templates
     *     exist for Spotify, Apple Music, and Bandcamp).
     *
     * Constraints added to these six columns must accept the full LML
     * shape. See WXYC/Backend-Service#702 + the artist-identity-etl
     * docs in CLAUDE.md.
     */
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
/**
 * SOURCE: legacy MySQL via `scripts/run-library-etl.sh` (and tubafrenzy
 * mirror writes for live additions). Library staff curate the music
 * collection in tubafrenzy/MySQL; Backend-Service is downstream. Shapes the
 * upstream permits and the ETL preserves include:
 *
 *   - NULL `artist_name` until the A.2 backfill / A.3 live-cascade has run
 *     for that row. Code paths reading `artist_name` must tolerate NULL.
 *   - NULL `album_artist`, `label`, `label_id`, `alternate_artist_name`,
 *     `artwork_url`, `on_streaming`, `code_volume_letters` (genuine library
 *     metadata gaps).
 *   - Multiple `library` rows pointing at the same `(artists.id,
 *     album_title)` — the legacy library is per-physical-format, so a CD
 *     and an LP issue of the same album are distinct rows.
 *   - NULL `canonical_entity_id` / `canonical_entity_confidence` /
 *     `canonical_entity_resolved_at` until LML resolves them (Epic B-1).
 *   - `legacy_release_id` is unique per row when present, but a small
 *     residual of rows have NULL `legacy_release_id` (orphaned from the
 *     ETL's link pass).
 *
 * Constraints added here must accept the full upstream shape, or they will
 * block the next library-etl pass. See WXYC/Backend-Service#702.
 */
export const library = wxyc_schema.table(
  'library',
  {
    id: serial('id').primaryKey(),
    // FK + notNull preserved from the upstream schema; library rows must
    // belong to an artist in tubafrenzy.
    artist_id: integer('artist_id')
      .references(() => artists.id)
      .notNull(), // eslint-disable-line wxyc/source-tagged-constraint-confirmed
    genre_id: integer('genre_id')
      .references(() => genres.id)
      .notNull(), // eslint-disable-line wxyc/source-tagged-constraint-confirmed
    format_id: integer('format_id')
      .references(() => format.id)
      .notNull(), // eslint-disable-line wxyc/source-tagged-constraint-confirmed
    alternate_artist_name: varchar('alternate_artist_name', { length: 128 }),
    album_artist: varchar('album_artist', { length: 128 }),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    album_title: varchar('album_title', { length: 128 }).notNull(),
    label: varchar('label', { length: 128 }),
    label_id: integer('label_id').references(() => labels.id),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    code_number: smallint('code_number').notNull(),
    code_volume_letters: varchar('code_volume_letters', { length: 4 }),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    disc_quantity: smallint('disc_quantity').default(1).notNull(),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    plays: integer('plays').default(0).notNull(),
    legacy_release_id: integer('legacy_release_id'),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    add_date: timestamp('add_date', { withTimezone: true }).defaultNow().notNull(),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
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
      // legacy_release_id is the surrogate key the legacy MySQL library
      // assigns each release; one row per legacy_release_id by the upstream
      // invariant (NULLs allowed for never-imported rows).
      // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
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

// Enrichment lifecycle for flowsheet track rows (BS#891). Replaces the
// implicit two-column state machine ({metadata_attempt_at,
// artwork_url/discogs_url}) with an explicit enum. Order is the lifecycle:
// `pending` → `enriching` → terminal (`enriched_match`, `enriched_no_match`,
// `failed_no_retry`).
//
//   pending           — never tried OR transient failure (retry-eligible).
//                       Default on every new row; the cron / Epic C consumer
//                       sweeps this slice.
//   enriching         — a consumer instance has claimed this row and is
//                       mid-LML-call. Set when the row flips from `pending`
//                       to `enriching` via the idempotent claim in Epic C
//                       C2 (#892). `enriching_since` carries the claim
//                       timestamp so the recovery sweep can revert stuck
//                       rows past a TTL (60 s in C6).
//   enriched_match    — LML returned full Discogs metadata; the populated
//                       columns on the row are authoritative.
//   enriched_no_match — LML succeeded but found no Discogs match. Only the
//                       synthesized YouTube/Bandcamp/SoundCloud search URLs
//                       are populated (post-#873 fallback path).
//   failed_no_retry   — exceeded the retry budget; terminal. The cron skips
//                       these rows and they require manual triage.
//
// Wire-format definition for iOS lives at `Shared/Playlist/Sources/Playlist/V2/
// MetadataStatus.swift` (raw values must stay in sync).
export const metadataStatusEnum = wxyc_schema.enum('metadata_status_enum', [
  'pending',
  'enriching',
  'enriched_match',
  'enriched_no_match',
  'failed_no_retry',
]);

// Provenance for `rotation.discogs_release_id` (BS#1029). Three values:
//
//   tubafrenzy_paste        — mirrored from tubafrenzy ROTATION_RELEASE
//                             .DISCOGS_RELEASE_ID by `jobs/rotation-etl`,
//                             populated by the rotation form's paste-URL
//                             prefill (music-director-verified).
//   lml_offline_backfill    — written by `jobs/rotation-release-id-backfill`
//                             (one-shot ETL, BS#1029) after LML resolved the
//                             `(artist, album)` tuple to a Discogs release id.
//   discogs_direct_backfill — written by the 2026-05-29 operator-run
//                             bypass-LML rescue after the 2026-05-28 picker-
//                             coverage regression collapsed LML matching. The
//                             resolver hit `api.discogs.com/database/search`
//                             directly with the `(artist, album)` pair, picked
//                             the top-ranked release whose VA-aware Jaccard
//                             scored >= 0.5 on both axes (relaxed retries for
//                             NO_RESULT: strip EP/LP/Mixtape suffix, drop
//                             bracketed annotations, self-titled coercion;
//                             diacritic strip + feat. carve-out for LOW_CONF).
//                             Tagged distinctly from `lml_offline_backfill` so
//                             a future LML-based re-run can scope its UPDATEs
//                             without clobbering the bypass-LML provenance.
//
// Column default is `tubafrenzy_paste` so existing pre-migration rows
// (PG11+ `attmissingval` virtual default) and new rotation-etl inserts
// are correctly attributed without rotation-etl having to set the column
// explicitly. The backfill writes `lml_offline_backfill` and the
// rotation-etl ON CONFLICT path flips it back to `tubafrenzy_paste`
// when tubafrenzy contributes a non-NULL id (COALESCE-paired with
// `rotation.discogs_release_id`).
export const discogsReleaseIdSourceEnum = wxyc_schema.enum('discogs_release_id_source_enum', [
  'tubafrenzy_paste',
  'lml_offline_backfill',
  'discogs_direct_backfill',
]);
/**
 * SOURCE: tubafrenzy via `jobs/rotation-etl/`. The music director writes
 * rotation rows in tubafrenzy; Backend-Service is downstream. Tubafrenzy
 * permits and the rotation-etl preserves shapes that constraints added
 * here can easily contradict:
 *
 *   - Multiple active rows per (album_id, rotation_bin) over an album's
 *     lifecycle (re-bins, re-adds, label-driven re-promotes). Do NOT add
 *     a partial-unique index on (album_id, rotation_bin) — see PR #696
 *     and the 2026-04-30 incident.
 *   - NULL `album_id` (rotation entries that pre-date or didn't link to
 *     a library row).
 *   - `kill_date` in the future (scheduled-kill rows are written ahead
 *     of time and only become "killed" when the date passes).
 *   - Rows with a populated `legacy_rotation_id` that haven't yet been
 *     joined to a library row by id.
 *
 * Constraints added to this table must accept the full upstream shape, or
 * they will block the next ETL pass. See WXYC/Backend-Service#702 +
 * CLAUDE.md (Rotation ETL: sync from tubafrenzy).
 */
export const rotation = wxyc_schema.table(
  'rotation',
  {
    id: serial('id').primaryKey(),
    album_id: integer('album_id').references(() => library.id, { onDelete: 'cascade' }),
    legacy_rotation_id: integer('legacy_rotation_id'),
    legacy_library_release_id: integer('legacy_library_release_id'),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    rotation_bin: freqEnum('rotation_bin').notNull(),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    add_date: date('add_date').defaultNow().notNull(),
    kill_date: date('kill_date'),
    artist_name: varchar('artist_name', { length: 128 }),
    album_title: varchar('album_title', { length: 128 }),
    record_label: varchar('record_label', { length: 128 }),
    // Mirrored from tubafrenzy ROTATION_RELEASE.DISCOGS_RELEASE_ID by
    // jobs/rotation-etl. Populated by the rotation form's paste-URL prefill
    // in tubafrenzy. NULL when the music director added the release without
    // a Discogs URL. Read path: getDiscogsReleaseIdByRotationId — reads
    // here first, falls back to library_identity for post-tubafrenzy-turndown
    // rows created via dj-site. Also written by
    // jobs/rotation-release-id-backfill (BS#1029) — see
    // `discogs_release_id_source` below for provenance.
    discogs_release_id: integer('discogs_release_id'),
    // Provenance for `discogs_release_id` (BS#1029). See
    // `discogsReleaseIdSourceEnum` above for value semantics. The DEFAULT
    // applies virtually to existing pre-migration rows; the
    // jobs/rotation-release-id-backfill writer overrides to
    // 'lml_offline_backfill' on the UPDATE that resolves a NULL id, and
    // the 2026-05-29 bypass-LML operator rescue (see migration 0086 +
    // scripts/relabel-rotation-direct-backfill.sql) writes
    // 'discogs_direct_backfill' for rows it resolved via direct
    // Discogs search.
    discogs_release_id_source: discogsReleaseIdSourceEnum('discogs_release_id_source')
      .notNull()
      .default('tubafrenzy_paste'),
    // Stamped by `resolveRotationDiscogsReleaseViaLml` when the tier-3 LML
    // cascade returns nothing for this row. The picker read path skips the
    // LML call when this is set within `ROTATION_TRACKLIST_LOOKUP_NEGATIVE_WINDOW_MS`,
    // mirroring `flowsheet.metadata_attempt_at` (#639). The per-process LRU
    // covers within-process repeat opens; this column covers across-restart
    // survival so the 28-row "negative" set doesn't re-pay 22 s cascade-
    // exhaustion on every deploy. NULL on transient LML failures (caught arm
    // — caller decides whether to retry) so the row stays retryable.
    tracklist_lookup_attempted_at: timestamp('tracklist_lookup_attempted_at', { withTimezone: true }),
  },
  (table) => {
    return {
      albumIdIdx: index('album_id_idx').on(table.album_id),
      // legacy_rotation_id is the surrogate key tubafrenzy assigns each
      // rotation row; one row per legacy_rotation_id by tubafrenzy's invariant.
      // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
      legacyRotationIdIdx: uniqueIndex('rotation_legacy_rotation_id_idx').on(table.legacy_rotation_id),
    };
  }
);

export type NewFSEntry = InferInsertModel<typeof flowsheet>;
export type FSEntry = InferSelectModel<typeof flowsheet>;
/**
 * SOURCE: tubafrenzy via the real-time webhook (`/internal/tubafrenzy-event`)
 * and `jobs/flowsheet-etl/`. DJs write flowsheet entries from tubafrenzy or
 * dj-site; tubafrenzy is the canonical authority and Backend-Service is
 * downstream. Shapes the upstream permits and the ETL/webhook preserve
 * include:
 *
 *   - NULL `show_id`, `album_id`, `rotation_id` (entries that pre-date a
 *     show, talkset / message rows, or never-linked tracks).
 *   - NULL `track_title`, `album_title`, `artist_name`, `record_label`
 *     (talkset / breakpoint / message / dj_join / dj_leave entries — see
 *     `flowsheetEntryTypeEnum` for non-track shapes).
 *   - `play_order` is set independently by tubafrenzy (webhook path) and
 *     dj-site (live insert path); the two paths can produce overlapping
 *     values and the read layer reconciles. Do NOT add a per-show UNIQUE
 *     on `play_order` — see the 2026-05-01 incident memo.
 *   - NULL metadata fields (`artwork_url`, `discogs_url`, `*_url`,
 *     `release_year`, `artist_bio`, `artist_wikipedia_url`,
 *     `metadata_attempt_at`) are valid before LML enrichment runs;
 *     `metadata_attempt_at` is specifically NULL on transient LML failures
 *     so the row stays retryable.
 *   - `legacy_entry_id` is unique per row when present, but a sizable
 *     residual of dj-site-originated rows have NULL `legacy_entry_id`.
 *   - `linkage_source` and `linkage_confidence` are NULL until B-2 / B-3
 *     resolves a linkage; do not add NOT NULL.
 *
 * Constraints added here must accept the full upstream shape, or they will
 * block the next ETL pass / webhook write. See WXYC/Backend-Service#702 +
 * the 2026-05-01 flowsheet/rotation incident.
 */
export const flowsheet = wxyc_schema.table(
  'flowsheet',
  {
    id: serial('id').primaryKey(),
    show_id: integer('show_id').references(() => shows.id, { onDelete: 'set null' }),
    album_id: integer('album_id').references(() => library.id, { onDelete: 'set null' }),
    rotation_id: integer('rotation_id').references(() => rotation.id, { onDelete: 'set null' }),
    // Overloaded across three orthogonal uses with different correctness
    // requirements (BS#908). Any new write site must register in
    // scripts/check-legacy-entry-id-writes.mjs ALLOWLIST with a rationale:
    //   1. Webhook upsert target — apps/backend/routes/internal.route.ts
    //      uses `ON CONFLICT (legacy_entry_id) DO UPDATE` keyed on the
    //      tubafrenzy-assigned entry ID.
    //   2. Mirror loop-guard — apps/backend/middleware/legacy/flowsheet.mirror.ts
    //      reads `legacy_entry_id != null` as a boolean meaning "this row
    //      came from tubafrenzy, do not mirror back" (avoids an infinite
    //      ETL → mirror → webhook → ETL loop).
    //   3. ETL incremental sync key — jobs/flowsheet-etl/job.ts uses the
    //      same `ON CONFLICT (legacy_entry_id)` shape as #1.
    // A future change that populates legacy_entry_id to a placeholder for
    // non-tubafrenzy rows would silently break use #2; the CI check at
    // scripts/check-legacy-entry-id-writes.mjs is the guardrail.
    legacy_entry_id: integer('legacy_entry_id'),
    legacy_release_id: integer('legacy_release_id'),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    entry_type: flowsheetEntryTypeEnum('entry_type').notNull().default('track'),
    track_title: varchar('track_title', { length: 128 }),
    // Discogs `release_track.position` (vinyl side or multi-disc prefix like
    // "A1", "B3", "1-12"). Written by the dj-site flowsheet picker (E6-6)
    // when a user selects a specific track off a release; NULL for legacy
    // rows, tubafrenzy mirror rows, and free-text entries. Wire shape decided
    // in WXYC/wxyc-shared#111 / #134 — TEXT because Discogs positions are
    // free-form strings, not integers. Projected onto V2 reads by
    // `transformToV2`.
    track_position: text('track_position'),
    album_title: varchar('album_title', { length: 128 }),
    artist_name: varchar('artist_name', { length: 128 }),
    record_label: varchar('record_label', { length: 128 }),
    label_id: integer('label_id').references(() => labels.id),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    play_order: integer('play_order').notNull(),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    request_flag: boolean('request_flag').default(false).notNull(),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    segue: boolean('segue').default(false).notNull(),
    message: varchar('message', { length: 250 }),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    add_time: timestamp('add_time', { withTimezone: true }).defaultNow().notNull(),
    // BS#902 (Epic F / F1). Per-row mutation timestamp. Bumped by the
    // BEFORE INSERT OR UPDATE trigger (`bump_flowsheet_updated_at`,
    // migration 0084), so every write — including the enrichment-worker
    // UPDATE that BS#628 reported never surfaced to a polling iOS client
    // — refreshes the row's stamp. The conditional-GET middleware
    // (`apps/backend/middleware/conditionalGet.ts`) does NOT read from
    // this column; it reads from the single-row `flowsheet_watermark`
    // sibling table, which the AFTER STATEMENT trigger advances on every
    // mutation including DELETE. A `MAX(updated_at)` read would retreat
    // when the row holding the peak is DELETEd and would cause polling
    // clients to 304 against a stale baseline — the sibling-table shape
    // sidesteps that. This column exists for future row-level callers
    // (ETag derivation, per-row staleness queries); the
    // `flowsheet_updated_at_idx` DESC index supports any such future
    // MAX/range scan.
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    // #639 marker: timestamp set when LML metadata fetch responded for this
    // row (success-with-match OR success-no-match). NULL has three causes,
    // all valid targets for the historical drain (#638) and the recurring
    // drift-repair sweep (#639 Phase 2):
    //   1. Row pre-dates this marker (every flowsheet row before 0069).
    //   2. Row was inserted between 0069's apply and the runtime stamp's
    //      deploy (the small race window during the same release).
    //   3. LML threw on the attempt — `.catch` in enrichment.service.ts
    //      logs to Sentry under subsystem='metadata' and leaves the column
    //      NULL precisely so the row stays retryable.
    // Lets both jobs target exactly the rows that still need an attempt,
    // without confusing tried-and-no-match for tried-and-LML-failed.
    // Stamped by `enrichment.service.ts` and #638's job.
    metadata_attempt_at: timestamp('metadata_attempt_at', { withTimezone: true }),
    // Explicit enrichment lifecycle (BS#891). See `metadataStatusEnum` above
    // for state semantics. Default `'pending'` covers every new row and every
    // pre-#891 historical row (the migration adds the column with this
    // constant default, which is a metadata-only ALTER on PG11+).
    //
    // The implicit state derived from {metadata_attempt_at, artwork_url,
    // discogs_url} is what every previous-PR consumer reads. This column
    // becomes the single source of truth once Epic C C2 (consumer) and C6
    // (cron) ship; `metadata_attempt_at` is kept as a historical marker but
    // is no longer used for control flow.
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    metadata_status: metadataStatusEnum('metadata_status').notNull().default('pending'),
    // Claim timestamp set by Epic C C2's consumer when flipping a row from
    // `pending` to `enriching`. NULL otherwise. C6's recovery sweep reads
    // this to decide which `enriching` rows have gone stale:
    //   UPDATE flowsheet SET metadata_status='pending', enriching_since=NULL
    //   WHERE metadata_status='enriching' AND enriching_since < now() - interval '60 seconds';
    // The `flowsheet_metadata_status_enriching_stale_idx` partial covers
    // that query.
    enriching_since: timestamp('enriching_since', { withTimezone: true }),
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
    // legacy_entry_id is the surrogate key tubafrenzy assigns each entry;
    // unique per row when present (NULL allowed for dj-site-originated rows
    // before the webhook round-trip).
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    uniqueIndex('flowsheet_legacy_entry_id_idx').on(table.legacy_entry_id),
    index('flowsheet_legacy_release_id_idx').on(table.legacy_release_id),
    index('flowsheet_artist_name_trgm_idx').using('gin', sql`${table.artist_name} gin_trgm_ops`),
    index('flowsheet_track_title_trgm_idx').using('gin', sql`${table.track_title} gin_trgm_ops`),
    index('flowsheet_album_title_trgm_idx').using('gin', sql`${table.album_title} gin_trgm_ops`),
    index('flowsheet_record_label_trgm_idx').using('gin', sql`${table.record_label} gin_trgm_ops`),
    // `flowsheet_dj_name_trgm_idx` removed in migration 0083 (#1060). dj-name
    // search is served by `flowsheet_search_doc_idx` (the search_doc tsvector
    // includes dj_name); the standalone trigram on dj_name was unused
    // (idx_scan=0 in prod over months of writes + 14 autovacuum cycles).
    // See parent epic #1058 for the broader write-amplification context.
    index('flowsheet_track_add_time_idx')
      .on(sql`${table.add_time} DESC`)
      .where(sql`${table.entry_type} = 'track'`),
    index('flowsheet_search_doc_idx').using('gin', sql`${table.search_doc}`),
    // BS#1012 (Epic D / D5). Functional partial index that supports the
    // post-D5 playlist-proxy artwork lookup. Same expression as
    // `flowsheet_artwork_lookup_idx` above, but the WHERE predicate switches
    // from `artwork_url IS NOT NULL` to `album_id IS NOT NULL` so the
    // partial set survives D4's drop of `flowsheet.artwork_url`.
    //
    // The new query path JOINs `album_metadata` on `flowsheet.album_id` and
    // reads `album_metadata.artwork_url`; an INNER JOIN to a PK column drops
    // `album_id IS NULL` rows naturally, so the partial predicate matches the
    // planner's effective filter and the index fires.
    //
    // Free-form (`album_id IS NULL`) rows are excluded from this index — they
    // can't carry album-keyed artwork. That mirrors D4's accepted free-form
    // tradeoff: inline artwork for unlinked entries disappears with D4 and is
    // not re-introduced here.
    index('flowsheet_album_link_lookup_idx')
      .on(sql`(lower(trim(${table.artist_name})) || '-' || lower(trim(coalesce(${table.album_title}, ''))))`)
      .where(sql`${table.album_id} IS NOT NULL`),
    // FK columns aren't auto-indexed by Postgres. Without this, the
    // /flowsheet `?shows_limit=N` listing endpoint sequentially scans the
    // 2.6M-row table on every dj-site poll. See migration 0068 + issue #511.
    index('flowsheet_show_id_idx').on(table.show_id),
    // `nextPlayOrder()` runs `SELECT max(play_order) FROM flowsheet` on every
    // POST /flowsheet/ to derive the next monotonic play_order. Without this
    // index that's a 2.6M-row parallel Seq Scan (~6s on prod) that exceeds
    // the 5s `DB_STATEMENT_TIMEOUT_MS`, so postgres-js cancels and the API
    // returns 500. With it, MAX is an O(1) leaf-page lookup. Built
    // CONCURRENTLY out-of-band on prod 2026-04-30 to unblock the flowsheet
    // during a live show. See migration 0071.
    index('flowsheet_play_order_idx').on(sql`${table.play_order} DESC`),
    // BS#902 (Epic F / F1). DESC B-tree on `updated_at` supports any
    // per-row staleness query that filters on `updated_at` (e.g. partial
    // ETag derivation downstream). The conditional-GET middleware itself
    // reads from `flowsheet_watermark` (single-row sibling table) so DELETE
    // can't move the watermark backward — see migration 0084's comment
    // block for the trigger fan-out. The DESC ordering makes `MAX()` an
    // O(1) leaf-page peek for any caller that prefers the row-level view.
    index('flowsheet_updated_at_idx').on(sql`${table.updated_at} DESC`),
    // Partial B-tree on (id) covering the `metadata_attempt_at IS NULL`
    // tail. Both #638 (historical drain) and #639 Phase 2 (recurring
    // drift-repair sweep) keyset-paginate through this slice — without
    // the index every batch seq-scans the 2.6M+ row table just to find
    // the small NULL residual. See migration 0070 + issue #659. Built
    // CONCURRENTLY out-of-band on prod before the migration deploys.
    index('flowsheet_metadata_attempt_pending_idx')
      .on(table.id)
      .where(
        sql`${table.entry_type} = 'track' AND ${table.artist_name} IS NOT NULL AND ${table.metadata_attempt_at} IS NULL`
      ),
    // Covering variant of the partial index above. The base index gets
    // the orchestrator to the right id range fast; the covering one
    // additionally INCLUDEs (artist_name, album_title, track_title,
    // add_time) so the orchestrator's loadBatch SELECT is an index-only
    // scan — no heap fetches per row, and the `add_time < now() - 60s`
    // race-guard predicate evaluates from the INCLUDE column.
    //
    // The 2026-05-04 #640 pilot showed 2125 ReadIOPS sustained (71% of
    // the gp3 3000 IOPS ceiling) for 0.834 rows/s — ~2550 reads per row,
    // dominated by heap fetches for those four columns and the buffer-
    // eviction collateral those reads produced on /library/* queries.
    // Index-only scan eliminates the per-row heap fetch on the SELECT
    // side; the buffer cache stays warm for the API path.
    //
    // INCLUDE columns are stored in the leaf pages and used for
    // index-only scans without heap access. The visibility map gates
    // when index-only scan applies — long-tail rows that autovacuum has
    // marked all-visible are eligible. Recently-UPDATEd rows aren't, but
    // the orchestrator moves forward by id and never re-reads its own
    // updates.
    //
    // Storage cost: ~250-350 MB on a 40 GB gp3 instance (~1% of disk).
    // Per-UPDATE write cost: one extra partial-index entry to delete
    // when the row's `metadata_attempt_at` flips to non-NULL — a single
    // leaf-page write. Net IOPS reduction: ~95% on reads, +1 leaf
    // write per UPDATE. Read:write ratio in the pilot was 92:1.
    //
    // INCLUDE columns aren't expressible through Drizzle's `index()`
    // builder, so the migration SQL is hand-edited (same pattern as the
    // hand-added IF NOT EXISTS in 0057, 0068, 0070). Drizzle's snapshot
    // sees this as a plain partial `(id)` index with no INCLUDE, so
    // future drizzle:generate runs don't drift; the actual DB carries
    // the INCLUDE columns via the migration SQL.
    index('flowsheet_metadata_attempt_pending_covering_idx')
      .on(table.id)
      .where(
        sql`${table.entry_type} = 'track' AND ${table.artist_name} IS NOT NULL AND ${table.metadata_attempt_at} IS NULL`
      ),
    // BS#891. Partial B-tree on (id) covering the `metadata_status = 'pending'`
    // slice. Replaces the `metadata_attempt_at IS NULL` partials above as the
    // sweep predicate once Epic C C6 (#895) flips the cron to read this
    // column. Both partials coexist during the transition — drop the old
    // `*_metadata_attempt_pending_*` partials in the same PR that flips the
    // cron, not here. Same predicate shape as 0070: filter on the three
    // clauses the cron query carries (entry_type, artist_name, the
    // lifecycle column itself).
    //
    // Built CONCURRENTLY out-of-band on prod first via:
    //   CREATE INDEX CONCURRENTLY flowsheet_metadata_status_pending_idx
    //     ON wxyc_schema.flowsheet (id)
    //     WHERE entry_type = 'track' AND artist_name IS NOT NULL
    //       AND metadata_status = 'pending';
    // Migration SQL carries IF NOT EXISTS so the apply is a no-op against
    // the prod DB where the index is already present.
    index('flowsheet_metadata_status_pending_idx')
      .on(table.id)
      .where(
        sql`${table.entry_type} = 'track' AND ${table.artist_name} IS NOT NULL AND ${table.metadata_status} = 'pending'`
      ),
    // BS#891. Partial B-tree on `enriching_since` covering the stale-claim
    // recovery sweep that Epic C C6 (#895) will run. Keyed on
    // `enriching_since` (not id) so the sweep can range-scan the slice
    // older than the TTL directly:
    //   UPDATE ... SET metadata_status='pending', enriching_since=NULL
    //   WHERE metadata_status='enriching' AND enriching_since < now() - interval '60s';
    // No artist_name / entry_type guard — `enriching` is only reachable from
    // `pending`, which the writer already gates on entry_type='track' AND
    // artist_name IS NOT NULL. Keeping the partial predicate minimal lets
    // the planner reach it from any future caller variant.
    index('flowsheet_metadata_status_enriching_stale_idx')
      .on(table.enriching_since)
      .where(sql`${table.metadata_status} = 'enriching'`),
    // BS#1022. Complementary partial B-tree on (album_id) covering the
    // `metadata_attempt_at IS NOT NULL` slice — the OPPOSITE partition from
    // the `_pending_` indexes above. Required by album-metadata-backfill's
    // `verifyComplete` (jobs/album-metadata-backfill/job.ts), which counts
    // `count(DISTINCT album_id) FROM flowsheet WHERE album_id IS NOT NULL
    // AND metadata_attempt_at IS NOT NULL`. Without it the planner falls
    // back to a 2.6M-row heap walk and trips the 5s `DB_STATEMENT_TIMEOUT_MS`
    // even after PR #1020 traded the LEFT JOIN for a dual-count. The same
    // INSERT … SELECT statement higher in the job shares this WHERE clause,
    // so the index also accelerates re-runs of the bulk move.
    //
    // Predicate matches the verify query verbatim — no `entry_type='track'`
    // guard so the planner can pick this index up from the literal WHERE
    // shape without requiring the verify query to be rewritten. (Non-track
    // entries always have `album_id IS NULL`, so the predicate naturally
    // restricts to track rows anyway.)
    //
    // Built CONCURRENTLY out-of-band on prod first; migration carries
    // `IF NOT EXISTS` per the docs/migrations.md `if-not-exists-index`
    // pattern. Expected size: ~50-100k entries (per BS#898's enriched-row
    // count), well under a megabyte. Build window: a few seconds.
    index('flowsheet_album_id_enriched_idx')
      .on(table.album_id)
      .where(sql`${table.album_id} IS NOT NULL AND ${table.metadata_attempt_at} IS NOT NULL`),
  ]
);

// Manual review queue for gray-zone LML matches (B-3.1, issue #501). The
// B-2.2 backfill enqueues a row per flowsheet entry whose LML lookup hit a
// fallback (right-artist, possibly-wrong-album). The CLI in
// `scripts/review-linkage.ts` drains this queue interactively. See
// migration 0066 for column rationale.
export type NewFlowsheetLinkageReview = InferInsertModel<typeof flowsheet_linkage_review>;
export type FlowsheetLinkageReview = InferSelectModel<typeof flowsheet_linkage_review>;
export const flowsheet_linkage_review = wxyc_schema.table(
  'flowsheet_linkage_review',
  {
    id: serial('id').primaryKey(),
    flowsheet_id: integer('flowsheet_id')
      .references(() => flowsheet.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    candidate_library_ids: integer('candidate_library_ids').array().notNull(),
    candidate_confidences: real('candidate_confidences').array().notNull(),
    suggested_action: text('suggested_action').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    reviewed_decision: text('reviewed_decision'),
  },
  (table) => [
    index('flowsheet_linkage_review_unreviewed_idx')
      .on(table.created_at)
      .where(sql`${table.reviewed_at} IS NULL`),
  ]
);

export type NewAlbumMetadata = InferInsertModel<typeof album_metadata>;
export type AlbumMetadata = InferSelectModel<typeof album_metadata>;
/**
 * Epic D / BS#897 — per-album extract of the 10 metadata columns currently
 * inlined on `flowsheet`. The flowsheet write path keeps writing those 10
 * columns; the V2 read path projects `COALESCE(album_metadata.col,
 * flowsheet.col)` so writers and readers cut over independently. D2
 * backfills historical rows; D3 reroutes the enrichment write path to
 * upsert here keyed by `album_id`; D4 drops the inline columns after ≥1
 * month of stabilization. See WXYC/Backend-Service#878 (epic), #897 (this
 * child), and the original framing in #532.
 *
 * `album_id` is the PK and the FK to `library.id`. Free-form flowsheet
 * entries (`album_id IS NULL`) don't reach this table — their metadata
 * stays inline on `flowsheet` until linkage resolves.
 */
/**
 * BS#902 (Epic F / F1). Single-row sibling watermark table that any
 * INSERT/UPDATE/DELETE on `flowsheet` advances via the
 * `touch_flowsheet_watermark` AFTER STATEMENT trigger (migration 0084).
 *
 * The conditional-GET middleware (`apps/backend/middleware/conditionalGet.ts`)
 * reads `last_modified_at` from this table on every poll. We can't reuse
 * `MAX(flowsheet.updated_at)` alone because DELETE on the row currently
 * holding the MAX would make the watermark *retreat* — a polling iOS
 * client's prior If-Modified-Since would 304 against the older surviving
 * MAX and miss the deletion. This sibling row only ever moves forward
 * (always `now()` on any mutation).
 *
 * The `id boolean PRIMARY KEY DEFAULT true` + `CHECK (id = true)` shape
 * is the standard singleton-row pattern: only one row can ever exist
 * (the seed inserted at migration apply time), so reads never need a
 * predicate beyond the implicit "the row".
 */
export const flowsheet_watermark = wxyc_schema.table(
  'flowsheet_watermark',
  {
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    id: boolean('id').primaryKey().notNull().default(true),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    last_modified_at: timestamp('last_modified_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (_table) => [
    // Singleton-row guard ships in migration 0084 (BS#902 / BS#628) but was
    // missing from the Drizzle table model, leaving the snapshot/schema diff
    // perpetually "out of sync". Adding the model here lets drizzle:generate
    // produce clean diffs for downstream PRs (BS#1029 surfaced this). The
    // raw `"id" = true` form (no schema/table qualification) matches 0084's
    // snapshot byte-for-byte so no DROP/ADD pair is generated.
    check('flowsheet_watermark_singleton', sql.raw(`"id" = true`)),
  ]
);

export const album_metadata = wxyc_schema.table('album_metadata', {
  // `.notNull()` is redundant with `.primaryKey()` at the SQL level (PK
  // implies NOT NULL), but Drizzle's `InferInsertModel` type derivation
  // only marks the column required when `.notNull()` is explicit — without
  // it, D3's writer (#899) could omit `album_id` and the TypeScript
  // compiler would silently accept it.
  album_id: integer('album_id')
    .primaryKey()
    .notNull()
    .references(() => library.id, { onDelete: 'cascade' }),
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
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

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
/**
 * SOURCE: tubafrenzy via `jobs/flowsheet-etl/` (and the live show-lifecycle
 * mirror in `apps/backend/middleware/legacy/flowsheet.mirror.ts`).
 * Tubafrenzy is the canonical authority for the show calendar / who's on
 * air; Backend-Service is downstream. Shapes the upstream permits and the
 * ETL preserves include:
 *
 *   - NULL `primary_dj_id` (legacy shows that pre-date the auth_user
 *     migration; "shadow" / fill-in shows logged before the operator
 *     account was provisioned).
 *   - NULL `specialty_id` (regular shows).
 *   - NULL `show_name` (most shows; only specialty shows carry a name).
 *   - NULL `end_time` (the active show — set when the DJ closes the show).
 *   - NULL `legacy_show_id`, `legacy_dj_id`, `legacy_dj_name` for shows
 *     that originated in dj-site (no tubafrenzy round-trip yet).
 *
 * Constraints added here must accept the full upstream shape, or they will
 * block the next flowsheet-etl pass / show-lifecycle webhook.
 * See WXYC/Backend-Service#702.
 */
export const shows = wxyc_schema.table(
  'shows',
  {
    id: serial('id').primaryKey(),
    primary_dj_id: varchar('primary_dj_id', { length: 255 }).references(() => user.id, { onDelete: 'set null' }),
    specialty_id: integer('specialty_id').references(() => specialty_shows.id),
    legacy_show_id: integer('legacy_show_id'),
    legacy_dj_name: varchar('legacy_dj_name', { length: 128 }),
    legacy_dj_id: integer('legacy_dj_id'),
    /**
     * Per-show DJ display-name override (BS#1321, epic #1288). When non-null
     * takes precedence over `auth_user.dj_name` for every flowsheet row on
     * this show — the show_start marker (written at join time), every track
     * row added via `addEntry` (via `resolveDjNameForShow`), and the
     * tubafrenzy mirror's `djHandle`.
     *
     * Distinct from `legacy_dj_name` on purpose: `legacy_dj_name` is owned
     * by the tubafrenzy ETL upsert (it gets overwritten on every sync tick
     * for shows that round-trip through tubafrenzy — see jobs/flowsheet-etl
     * line 346), so it can't be the persistence target for an operator
     * intent. The override is a Backend-Service-only field; nothing on the
     * ETL side writes it.
     *
     * Capped at 255 to match the `auth_user.dj_name` width and the
     * `dj_name_override` request parameter cap. The dj-site joinShow
     * controller and the service-layer `startShow` both length-check
     * defensively before INSERT.
     */
    dj_name_override: varchar('dj_name_override', { length: 255 }),
    show_name: varchar('show_name', { length: 128 }),
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
    start_time: timestamp('start_time', { withTimezone: true }).defaultNow().notNull(),
    end_time: timestamp('end_time', { withTimezone: true }),
  },
  (table) => [
    // legacy_show_id is the surrogate key tubafrenzy assigns each show; one
    // row per legacy_show_id by the upstream invariant. NULL allowed for
    // dj-site-originated shows.
    // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
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
      // Keyed read for the artist_search_alias LATERAL JOIN (PR 5).
      artist_id: library.artist_id,
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
  artist_id: number;
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

// Cross-cache-identity substrate (§3.2 of the library-hook-canonicalization
// plan). Three empty tables behind `BS_USE_LIBRARY_IDENTITY=false`. No writers
// or readers reference these in this PR — backfill (§4 step 2) and the
// dual-table writer (§3.2.2.2) ship in follow-up PRs under epic E2-BS (#663).
//
// Naming convention:
//   - `library_identity`         — main row, one per library row (denormalized convenience view)
//   - `library_identity_source`  — sidecar, one row per (library_id, source) — per-source-of-truth detail
//   - `library_identity_history` — supersedure log, one row per superseded decision
//
// The `library_identity.distinct_unresolved_sources` STORED generated column
// is the audit-view helper described in §3.2; it counts how many of the eight
// known sources are still NULL on this row.

export const library_identity = wxyc_schema.table(
  'library_identity',
  {
    library_id: integer('library_id')
      .primaryKey()
      .references(() => library.id),
    discogs_master_id: integer('discogs_master_id'),
    discogs_release_id: integer('discogs_release_id'),
    musicbrainz_release_group_mbid: uuid('musicbrainz_release_group_mbid'),
    musicbrainz_release_mbid: uuid('musicbrainz_release_mbid'),
    musicbrainz_recording_mbid: uuid('musicbrainz_recording_mbid'),
    wikidata_qid: text('wikidata_qid'),
    spotify_id: text('spotify_id'),
    apple_music_id: text('apple_music_id'),
    last_verified_at: timestamp('last_verified_at', { withTimezone: true }).notNull(),
    method: text('method').notNull(),
    confidence: real('confidence').notNull(),
    agreement_sources: text('agreement_sources'),
    notes: text('notes'),
    distinct_unresolved_sources: integer('distinct_unresolved_sources').generatedAlwaysAs(
      sql`(
        (CASE WHEN "discogs_master_id" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "discogs_release_id" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "musicbrainz_release_group_mbid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "musicbrainz_release_mbid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "musicbrainz_recording_mbid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "wikidata_qid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "spotify_id" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "apple_music_id" IS NULL THEN 1 ELSE 0 END)
      )`
    ),
  },
  (table) => [
    check('library_identity_confidence_range', sql`${table.confidence} BETWEEN 0 AND 1`),
    index('library_identity_audit_idx').on(table.confidence, sql`${table.distinct_unresolved_sources} DESC`),
  ]
);

export type LibraryIdentity = InferSelectModel<typeof library_identity>;
export type NewLibraryIdentity = InferInsertModel<typeof library_identity>;

export const library_identity_source = wxyc_schema.table(
  'library_identity_source',
  {
    library_id: integer('library_id')
      .notNull()
      .references(() => library.id),
    source: text('source').notNull(),
    external_id: text('external_id').notNull(),
    method: text('method').notNull(),
    confidence: real('confidence').notNull(),
    last_verified_at: timestamp('last_verified_at', { withTimezone: true }).notNull(),
    boost_sources: text('boost_sources'),
    notes: text('notes'),
  },
  (table) => [
    primaryKey({ columns: [table.library_id, table.source] }),
    check('library_identity_source_confidence_range', sql`${table.confidence} BETWEEN 0 AND 1`),
  ]
);

export type LibraryIdentitySource = InferSelectModel<typeof library_identity_source>;
export type NewLibraryIdentitySource = InferInsertModel<typeof library_identity_source>;

export const library_identity_history = wxyc_schema.table('library_identity_history', {
  history_id: serial('history_id').primaryKey(),
  library_id: integer('library_id').notNull(),
  // Snapshot of the per-row state at supersedure time. NOT FK-referenced to
  // `library` because we may need the history row to outlive the library
  // row's deletion for compliance / forensics.
  discogs_master_id: integer('discogs_master_id'),
  discogs_release_id: integer('discogs_release_id'),
  musicbrainz_release_group_mbid: uuid('musicbrainz_release_group_mbid'),
  musicbrainz_release_mbid: uuid('musicbrainz_release_mbid'),
  musicbrainz_recording_mbid: uuid('musicbrainz_recording_mbid'),
  wikidata_qid: text('wikidata_qid'),
  spotify_id: text('spotify_id'),
  apple_music_id: text('apple_music_id'),
  last_verified_at: timestamp('last_verified_at', { withTimezone: true }),
  method: text('method'),
  confidence: real('confidence'),
  agreement_sources: text('agreement_sources'),
  notes: text('notes'),
  // Supersedure metadata.
  superseded_at: timestamp('superseded_at', { withTimezone: true }).notNull().defaultNow(),
  superseded_reason: text('superseded_reason').notNull(),
  reason_category: text('reason_category'),
  archived_at: timestamp('archived_at', { withTimezone: true }),
});

export type LibraryIdentityHistory = InferSelectModel<typeof library_identity_history>;
export type NewLibraryIdentityHistory = InferInsertModel<typeof library_identity_history>;

/**
 * Source-agnostic cache of alias / variant / member strings for each WXYC
 * artist, populated by `jobs/artist-search-alias-consumer/` (artist-search-alias
 * plan PR 4) from LML's `POST /api/v1/artists/search-aliases/bulk` plus a
 * shadow-ingest of `library.alternate_artist_name`. Read by the catalog search
 * via a LATERAL JOIN keyed on `artist_id` (PR 5).
 *
 * The `source` column tags origin; new sources are additive (no schema
 * migration). Design + acceptance live in WXYC/Backend-Service#1264 and the
 * artist-search-alias plan referenced therein.
 *
 * Cascade behavior:
 *   - `artist_id` ON DELETE CASCADE — alias rows belong to the artist.
 *   - `related_artist_id` ON DELETE SET NULL — the related (alias/member)
 *     artist may be removed independently without orphaning the cache row.
 */
export const artist_search_alias = wxyc_schema.table(
  'artist_search_alias',
  {
    artist_id: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    variant: text('variant').notNull(),
    related_artist_id: integer('related_artist_id').references(() => artists.id, {
      onDelete: 'set null',
    }),
    external_subject_id: text('external_subject_id'),
    external_object_id: text('external_object_id'),
    active: boolean('active'),
    method: text('method').notNull(),
    confidence: real('confidence').notNull(),
    last_verified_at: timestamp('last_verified_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'artist_search_alias_pkey',
      columns: [table.artist_id, table.source, table.variant],
    }),
    index('artist_search_alias_variant_trgm_idx').using('gin', sql`${table.variant} gin_trgm_ops`),
    check('artist_search_alias_confidence_range', sql`${table.confidence} BETWEEN 0 AND 1`),
    check('artist_search_alias_variant_nonblank', sql`length(trim(${table.variant})) > 0`),
  ]
);

export type ArtistSearchAlias = InferSelectModel<typeof artist_search_alias>;
export type NewArtistSearchAlias = InferInsertModel<typeof artist_search_alias>;

/**
 * Where a concert record came from. New values land when we add a new
 * ingestion path (Bandsintown live-fetch is kept OUT of this table because
 * its ToS forbids persistent caching — only sources we own go here).
 */
export const concertSourceEnum = wxyc_schema.enum('concert_source_enum', [
  'rhp_scrape', // Rockhouse Partners venue sites (catscradle.com, local506.com, ...)
]);

/**
 * Lifecycle state of a concert. Listener-facing surfaces (the iOS app's
 * "Touring Soon" tab, the dj-site weekly digest) read this to grey out /
 * hide / strike through. The scraper writes `on_sale` by default and
 * promotes to `sold_out` / `cancelled` when the source page says so.
 */
export const concertStatusEnum = wxyc_schema.enum('concert_status_enum', [
  'on_sale',
  'sold_out',
  'cancelled',
  'rescheduled',
]);

/**
 * Live-music venues whose calendars we ingest. Seeded by each scraper's
 * venue config at first run; admin-editable thereafter (the seed key is
 * `slug`, which the scraper looks up to attach a `venue_id` to each
 * concert). Held separately from `concerts` because we want venue-level
 * facts (name, address, coords if we add them later) to live in one place
 * even when no upcoming concert references the venue.
 */
export const venues = wxyc_schema.table(
  'venues',
  {
    id: serial('id').primaryKey(),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    city: varchar('city', { length: 64 }).notNull(),
    state: varchar('state', { length: 32 }).notNull(),
    address: varchar('address', { length: 256 }),
    added_at: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
    last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('venues_slug_idx').on(table.slug)]
);

export type Venue = InferSelectModel<typeof venues>;
export type NewVenue = InferInsertModel<typeof venues>;

/**
 * One row per known upcoming or recent concert, multi-source.
 *
 * The same logical concert can have rows from multiple `source`s (e.g., an
 * `rhp_scrape` row plus a future `submission` row from a promoter). Dedup
 * is intentionally deferred to a read-time view so we keep an audit trail
 * of who told us what and when. Per-source uniqueness is enforced via
 * `(source, source_id)` so re-scrapes UPSERT in place.
 *
 * `headlining_artist_id` is best-effort — LML's canonical-entity coverage
 * is ~24% (see [[project_lml_entity_identity_state]]) so most rows ship
 * with a NULL id and just the raw name. A future artist-resolver pass
 * backfills the id without changing the raw column.
 *
 * `raw_data` carries the source's original payload (the parsed schema.org
 * `Event` object for `rhp_scrape`) so we can forensically diff when the
 * source's format changes.
 *
 * `scraped_at` refreshes on every UPSERT (last scrape), so MIN(scraped_at)
 * collapses to "most recent scraper run" once the scraper has been running
 * for a while. `first_scraped_at` is the forward-only anchor for the same
 * question — added in migration 0093 (BS#1385), held constant across
 * re-UPSERTs by the writer's omission from the ON CONFLICT `set` clause.
 * Rows backfilled at migration time carry the migration timestamp, not
 * their original scrape time; the column is meaningful only for rows
 * inserted after 2026-06-10.
 */
export const concerts = wxyc_schema.table(
  'concerts',
  {
    id: serial('id').primaryKey(),
    source: concertSourceEnum('source').notNull(),
    source_id: varchar('source_id', { length: 256 }).notNull(),
    venue_id: integer('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'restrict' }),
    starts_at: timestamp('starts_at', { withTimezone: true }).notNull(),
    headlining_artist_raw: varchar('headlining_artist_raw', { length: 256 }).notNull(),
    headlining_artist_id: integer('headlining_artist_id').references(() => artists.id, {
      onDelete: 'set null',
    }),
    supporting_artists_raw: text('supporting_artists_raw')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ticket_url: text('ticket_url'),
    image_url: text('image_url'),
    status: concertStatusEnum('status').notNull().default('on_sale'),
    raw_data: jsonb('raw_data').notNull(),
    scraped_at: timestamp('scraped_at', { withTimezone: true }).notNull(),
    // INSERT-only scraper-stability anchor — writer omits from ON CONFLICT
    // set so re-UPSERTs preserve the insert moment. See BS#1385 (migration
    // 0093) and the table JSDoc above for the full rationale.
    first_scraped_at: timestamp('first_scraped_at', { withTimezone: true }).defaultNow().notNull(),
    last_modified: timestamp('last_modified', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('concerts_source_source_id_idx').on(table.source, table.source_id),
    index('concerts_venue_starts_at_idx').on(table.venue_id, table.starts_at),
    index('concerts_headlining_artist_starts_at_idx').on(table.headlining_artist_id, table.starts_at),
  ]
);

export type Concert = InferSelectModel<typeof concerts>;
export type NewConcert = InferInsertModel<typeof concerts>;
