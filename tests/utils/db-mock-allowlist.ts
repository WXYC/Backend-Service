/**
 * The recorded drift backlog for `tests/mocks/database.mock.ts` (BS#2448).
 *
 * ## These are debt markers, not exemptions
 *
 * Every entry below is a place where a unit assertion about that column
 * **cannot fail**. A column missing from a double reads as `undefined`, and
 * `expect(fn).toHaveBeenCalledWith({ format_id: undefined })` matches a call
 * that omitted the key entirely — so the assertion is green whether the
 * production code writes the column or not. That is the bug this list
 * describes; it is not a statement that the column does not matter.
 *
 * ## The list may only shrink
 *
 * `npm run check:db-mock-sync` fails on anything missing that is NOT listed
 * here, so new drift is blocked from the moment this lands. It ALSO fails on
 * any entry here that is no longer needed — a column since added to the
 * double, or one schema.ts no longer declares — so the list cannot quietly
 * rot into a permanent exemption, and fixing a double forces the matching line
 * to be deleted in the same commit.
 *
 * **Never add an entry to make a failing check pass.** The check is telling you
 * a column you just added to `schema.ts` is missing from its double; add it to
 * the double. The only legitimate edit to this file is a deletion.
 *
 * ## Snapshot when this was written
 *
 * Measured against `shared/database/src/schema.ts` with drizzle's
 * `getTableColumns` / `getViewSelectedFields`:
 *
 *   - 66 tables + views in the schema, 48 doubles present
 *   - 18 tables/views with **no double at all** (`missingDoubles`)
 *   - 148 missing columns across 22 doubles (`missingColumns`)
 *
 * Worst offenders: `library_artist_view` 25, `digital_asset` 18, `library` 16,
 * `library_identity` 13, `artists` 9.
 *
 * Seven doubles are still declared bare `{}` and appear here with their full
 * column list: `anonymous_devices`, `user_activity`, `genres`,
 * `specialty_shows`, `schedule`, `artist_crossreference`, `cronjob_runs`.
 * Those are the acute case — two empty doubles are structurally identical, so
 * `toHaveBeenCalledWith(labels)` is satisfied by a call that passed `format`.
 * (`labels` and `format` themselves were filled in when the sentinels were
 * qualified, which is why they are absent from this list.)
 */
import type { DbMockAllowlist } from './db-mock-parity';

export const DB_MOCK_ALLOWLIST: DbMockAllowlist = {
  missingDoubles: [
    'account',
    'deviceCode',
    'dj_stats',
    'invitation',
    'jwks',
    'library_identity_history',
    'member',
    'oauthAccessToken',
    'oauthApplication',
    'oauthConsent',
    'organization',
    'reviews',
    'rotation_library_view',
    'session',
    'shift_covers',
    'station_passcode',
    'station_signup_attempt',
    'verification',
  ],
  missingColumns: {
    anonymous_devices: [
      'id',
      'deviceId',
      'createdAt',
      'lastSeenAt',
      'blocked',
      'blockedAt',
      'blockedReason',
      'requestCount',
    ],
    artist_crossreference: ['source_artist_id', 'target_artist_id', 'comment'],
    artist_library_crossreference: ['comment'],
    artist_metadata: ['artist_bio'],
    artists: [
      'alphabetical_name',
      'code_letters',
      'add_date',
      'last_modified',
      'musicbrainz_artist_id',
      'wikidata_qid',
      'spotify_artist_id',
      'apple_music_artist_id',
      'bandcamp_id',
    ],
    concerts: ['event_url'],
    cronjob_runs: ['job_name', 'last_run', 'cursor_position'],
    digital_asset: [
      'bind_note',
      'verification_method',
      'accuraterip_confidence',
      'c2_error_count',
      'has_htoa',
      'hdcd',
      'pre_emphasis',
      'has_data_session',
      'has_subchannel',
      'identity_qc_flag',
      'rip_log_key',
      'cue_sheet_key',
      'toc_key',
      'data_session_key',
      'album_gain_db',
      'ripped_by',
      'ripped_at',
      'created_at',
    ],
    digital_asset_file: ['bytes', 'sha256', 'flac_md5', 'tag_artist', 'tag_album', 'tag_track'],
    digital_asset_store: ['created_at'],
    flowsheet: ['track_position', 'radio_hour', 'composer', 'composer_source'],
    genres: ['id', 'genre_name', 'description', 'plays', 'add_date', 'last_modified'],
    library: [
      'genre_id',
      'format_id',
      'alternate_artist_name',
      'album_artist',
      'album_title',
      'label',
      'label_id',
      'code_number',
      'code_volume_letters',
      'disc_quantity',
      'plays',
      'add_date',
      'last_modified',
      'date_lost',
      'date_found',
      'unresolved_attempted_at',
    ],
    library_artist_view: [
      'id',
      'code_letters',
      'code_artist_number',
      'code_number',
      'artist_name',
      'alphabetical_name',
      'album_title',
      'format_name',
      'genre_name',
      'rotation_bin',
      'add_date',
      'label',
      'label_id',
      'album_artist',
      'plays',
      'artwork_url',
      'discogs_artist_id',
      'musicbrainz_artist_id',
      'wikidata_qid',
      'spotify_artist_id',
      'apple_music_artist_id',
      'bandcamp_id',
      'discogs_unavailable',
      'discogs_unavailable_note',
      'last_discogs_recheck_at',
    ],
    library_delete_denylist: ['deleted_by_user_id', 'deleted_by_email', 'deleted_by_role'],
    library_identity: [
      'discogs_master_id',
      'musicbrainz_release_group_mbid',
      'musicbrainz_release_mbid',
      'musicbrainz_recording_mbid',
      'wikidata_qid',
      'spotify_id',
      'apple_music_id',
      'last_verified_at',
      'method',
      'confidence',
      'agreement_sources',
      'notes',
      'distinct_unresolved_sources',
    ],
    library_identity_source: ['method', 'confidence', 'last_verified_at', 'boost_sources', 'notes'],
    rotation: ['format_id', 'label_id', 'discogs_release_id_source', 'lml_identity_id'],
    schedule: ['id', 'day', 'start_time', 'show_duration', 'specialty_id', 'assigned_dj_id', 'assigned_dj_id2'],
    specialty_shows: ['id', 'specialty_name', 'description', 'add_date', 'last_modified'],
    user: [
      'hasCompletedOnboarding',
      'selfSignupAt',
      'selfSignupReviewedAt',
      'selfSignupReviewedBy',
      'selfSignupDowngradedAt',
    ],
    user_activity: ['userId', 'requestCount', 'lastSeenAt', 'createdAt'],
  },
};
