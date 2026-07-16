/**
 * Pure sheet-row -> `album_review_submissions` mapping (the
 * album-reviews-sheet-sync plan's header-mapping contract). No DB, no
 * network — everything contract-shaped lives here so the unit suite can
 * pin it without mocks.
 *
 * Column resolution is HEADER-BASED, never positional: the live sheet
 * carries dead columns (empty headers, a stray `122`, and an abandoned
 * early long-form buzzwords column with 0 responses), and Google Forms
 * appends columns as the form evolves. Each live column resolves by a
 * distinctive case-insensitive prefix — except `Buzzwords`, which must
 * EXACT-match because the prefix rule would collide with the dead
 * long-form "Buzzwords about the album (examples include...)" column.
 *
 * Keying: `source_key = 'form:' + <ISO-8601 UTC>` of the parsed form
 * timestamp (unique across all current rows). A data row with a
 * missing/unparseable timestamp falls back to
 * `nots:<norm_artist>:<norm_album>:<sha256[0:8](reviewer_raw)>` — the
 * reviewer-hash suffix makes two distinct timestamp-less reviews of the
 * same album collision-proof, and the hash deliberately EXCLUDES the
 * review body so curation edits still propagate as updates (an edited
 * reviewer string mints a new row — acceptable, warn-logged upstream via
 * the `fallback_key` flag).
 */

import { createHash } from 'node:crypto';
import {
  normalizeArtistName,
  normalizeAlbumTitle,
  nyWallClockToUtc,
  type NewAlbumReviewSubmission,
} from '@wxyc/database';

/** Column indexes resolved from the sheet's header row. `null` marks an
 *  optional column absent from the sheet; the required four are throw-
 *  guarded in `resolveHeaderIndexes`. */
export type HeaderIndexes = {
  timestamp: number;
  artist: number;
  album: number;
  review: number;
  record_label: number | null;
  artist_blurb: number | null;
  recommended_tracks: number | null;
  reviewer: number | null;
  fcc_violations: number | null;
  buzzwords: number | null;
  social_consent: number | null;
  released_within_six_months: number | null;
  review_purpose: number | null;
  rotated: number | null;
};

/** Everything the writer UPSERTs: the full insert shape minus the columns
 *  the ETL never authors — `id` (serial), `album_id` (link-pass-owned),
 *  `add_date`/`last_modified` (DB defaults; the writer refreshes
 *  `last_modified` itself). */
export type SubmissionContent = Omit<NewAlbumReviewSubmission, 'id' | 'album_id' | 'add_date' | 'last_modified'>;

export type MappedRow =
  | {
      kind: 'valid';
      content: SubmissionContent;
      /** True when the row keyed via the `nots:` fallback (warn-logged upstream). */
      fallback_key: boolean;
      /** Normalization anomalies (unrecognized closed-vocabulary values). */
      warnings: string[];
    }
  | { kind: 'invalid'; reason: string };

const findByPrefix = (lowered: string[], prefix: string): number | null => {
  const idx = lowered.findIndex((h) => h.startsWith(prefix));
  return idx === -1 ? null : idx;
};

const findExact = (lowered: string[], exact: string): number | null => {
  const idx = lowered.indexOf(exact);
  return idx === -1 ? null : idx;
};

/**
 * Resolve column indexes from the header row. Tolerant of column reorder
 * and future additions; throws when any REQUIRED header (Timestamp,
 * Artist Name, Album Name, the review body) is missing — a sheet whose
 * required headers vanished is a contract break, not a mappable state.
 */
export const resolveHeaderIndexes = (headerRow: string[]): HeaderIndexes => {
  const lowered = headerRow.map((h) => (h ?? '').trim().toLowerCase());

  const required = (prefix: string, label: string): number => {
    const idx = findByPrefix(lowered, prefix);
    if (idx === null) {
      throw new Error(`resolveHeaderIndexes: required header '${label}' (prefix '${prefix}') not found in sheet`);
    }
    return idx;
  };

  return {
    timestamp: required('timestamp', 'Timestamp'),
    artist: required('artist name', 'Artist Name'),
    album: required('album name', 'Album Name'),
    review: required('please write your review here', 'review body'),
    record_label: findByPrefix(lowered, 'record label'),
    artist_blurb: findByPrefix(lowered, 'please write a short 1-2 sentences'),
    recommended_tracks: findByPrefix(lowered, 'please identify at least 2'),
    reviewer: findByPrefix(lowered, 'name of reviewer'),
    fcc_violations: findByPrefix(lowered, 'list any fcc violations'),
    // EXACT match — the prefix rule would collide with the dead long-form
    // buzzwords column (module docstring).
    buzzwords: findExact(lowered, 'buzzwords'),
    social_consent: findByPrefix(lowered, 'are you comfortable'),
    released_within_six_months: findByPrefix(lowered, 'was this album released'),
    review_purpose: findByPrefix(lowered, 'what is this review for'),
    rotated: findByPrefix(lowered, 'rotated? (y/n)'),
  };
};

// M/D/YYYY H:MM:SS (the sheet locale); seconds optional defensively.
const FORM_TIMESTAMP_SHAPE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse the form's `M/D/YYYY H:MM:SS` timestamp as a wall-clock
 * America/New_York reading and return the UTC instant, or null when the
 * value doesn't parse. DST is handled by `nyWallClockToUtc`'s Intl-based
 * offset resolution (no dependency) — unit-tested here on an EST and an
 * EDT sample.
 */
export const parseFormTimestamp = (raw: string): Date | null => {
  const match = raw.trim().match(FORM_TIMESTAMP_SHAPE);
  if (!match) return null;
  const [, month, day, year, hour, minute, second] = match;
  // Reject impossible calendar dates explicitly: ECMA-262's ISO parse
  // ROLLS a 2/30 over into March instead of erroring, which would file the
  // row under a fabricated date. Round-trip through Date.UTC to detect.
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  try {
    // nyWallClockToUtc rejects out-of-range times (hour > 23, minute > 59).
    return nyWallClockToUtc(isoDate, `${hour}:${minute}:${second ?? '00'}`);
  } catch {
    return null;
  }
};

const cell = (row: string[], idx: number | null): string | null => {
  if (idx === null) return null;
  const trimmed = (row[idx] ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

type Normalized = { value: boolean | null; anomaly: boolean };

/** `rotated? (y/n)`: y/Y -> true, any n-prefixed value -> false (covers
 *  'n', 'no', and the 'N/A ...' family), blank -> null (unanswered, not an
 *  anomaly), anything else -> null + warn. */
const normalizeRotated = (raw: string | null): Normalized => {
  if (raw === null) return { value: null, anomaly: false };
  const lowered = raw.toLowerCase();
  if (lowered === 'y') return { value: true, anomaly: false };
  if (lowered.startsWith('n')) return { value: false, anomaly: false };
  return { value: null, anomaly: true };
};

/** Social-media consent: y-/ok-prefixed -> true (every "remove my name"
 *  variant is still consent=true — names are never shared regardless),
 *  exactly 'no' -> false, blank -> null, anything else -> null + warn.
 *  The raw string is kept verbatim in `social_consent_raw`. */
const normalizeSocialConsent = (raw: string | null): Normalized => {
  if (raw === null) return { value: null, anomaly: false };
  const lowered = raw.toLowerCase();
  if (lowered.startsWith('y') || lowered.startsWith('ok')) return { value: true, anomaly: false };
  if (lowered === 'no') return { value: false, anomaly: false };
  return { value: null, anomaly: true };
};

/** Yes/No dropdown: anything else is drift -> null + warn. */
const normalizeYesNo = (raw: string | null): Normalized => {
  if (raw === null) return { value: null, anomaly: false };
  const lowered = raw.toLowerCase();
  if (lowered === 'yes') return { value: true, anomaly: false };
  if (lowered === 'no') return { value: false, anomaly: false };
  return { value: null, anomaly: true };
};

/**
 * Map one data row. Returns `invalid` (counted + logged upstream, never
 * thrown) when artist or album is blank — the validity rule that drops
 * the sheet's formula-residue junk row.
 */
export const mapRow = (row: string[], headers: HeaderIndexes): MappedRow => {
  const artist = cell(row, headers.artist);
  const album = cell(row, headers.album);
  if (artist === null || album === null) {
    return { kind: 'invalid', reason: `missing ${artist === null ? 'artist' : 'album'}` };
  }

  const warnings: string[] = [];
  const reviewerRaw = cell(row, headers.reviewer);
  const consentRaw = cell(row, headers.social_consent);
  const rotatedRaw = cell(row, headers.rotated);
  const sixMonthsRaw = cell(row, headers.released_within_six_months);

  const rotated = normalizeRotated(rotatedRaw);
  if (rotated.anomaly) warnings.push(`unrecognized rotated value ${JSON.stringify(rotatedRaw)}`);
  const consent = normalizeSocialConsent(consentRaw);
  if (consent.anomaly) warnings.push(`unrecognized social_consent value ${JSON.stringify(consentRaw)}`);
  const sixMonths = normalizeYesNo(sixMonthsRaw);
  if (sixMonths.anomaly) {
    warnings.push(`unrecognized released_within_six_months value ${JSON.stringify(sixMonthsRaw)}`);
  }

  const normArtist = normalizeArtistName(artist);
  const normAlbum = normalizeAlbumTitle(album);
  const submittedAt = parseFormTimestamp(cell(row, headers.timestamp) ?? '');
  // The fallback hashes the reviewer string ONLY — not the review body —
  // so curation edits keep the same key (module docstring).
  const sourceKey =
    submittedAt !== null
      ? `form:${submittedAt.toISOString()}`
      : `nots:${normArtist}:${normAlbum}:${createHash('sha256')
          .update(reviewerRaw ?? '')
          .digest('hex')
          .slice(0, 8)}`;

  return {
    kind: 'valid',
    fallback_key: submittedAt === null,
    warnings,
    content: {
      artist_name: artist,
      album_title: album,
      record_label: cell(row, headers.record_label),
      artist_blurb: cell(row, headers.artist_blurb),
      review: cell(row, headers.review),
      recommended_tracks: cell(row, headers.recommended_tracks),
      buzzwords: cell(row, headers.buzzwords),
      // Verbatim — blank ≠ "None"; the n/a family is deliberately kept.
      fcc_violations: cell(row, headers.fcc_violations),
      review_purpose: cell(row, headers.review_purpose),
      reviewer_raw: reviewerRaw,
      social_consent_raw: consentRaw,
      social_consent: consent.value,
      released_within_six_months: sixMonths.value,
      rotated: rotated.value,
      submitted_at: submittedAt,
      // Written explicitly rather than relying on the column default.
      source: 'google_form',
      source_key: sourceKey,
      norm_artist: normArtist,
      norm_album: normAlbum,
    },
  };
};
