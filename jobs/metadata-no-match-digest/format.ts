/**
 * Pure rendering logic for the metadata-no-match digest email. No DB, no
 * network -- everything here takes `NoMatchRow[]` (see `query.ts`) and plain
 * `Date`s and returns strings. Kept pure and heavily unit-tested per the
 * plan: this is the part most likely to be iterated on (wording, grouping,
 * top-N tuning) without touching the DB or SES seams.
 */
import type { NoMatchRow } from './query.js';

export type { NoMatchRow };

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

/** e.g. "2026-07-31" -- the Pacific *calendar* date for a UTC instant, which can differ from the UTC date. */
export const formatPacificDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

/**
 * e.g. "2026-07-31 8:07 AM PT". Always labeled "PT", never "PST"/"PDT" --
 * the cron fires at a fixed UTC instant (`07 15 * * *`), so the rendered
 * Pacific wall-clock hour (and, near midnight, the calendar date) silently
 * drifts by one hour across the DST boundary. See README.md.
 */
export const formatPacificDateTime = (date: Date): string => {
  const datePart = formatPacificDate(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  return `${datePart} ${timePart} PT`;
};

/**
 * Synthesize a Discogs release-search URL for a playcut. Reused for both
 * Section A (per-row) and Section B (per artist group, track omitted).
 * Nulls degrade gracefully rather than throwing -- a row can legitimately
 * have a null `track_title` on data this old/free-text.
 */
export const synthesizeDiscogsSearchUrl = (artistName: string | null, trackTitle: string | null): string => {
  const parts = [artistName, trackTitle].filter((part): part is string => !!part && part.trim().length > 0);
  const query = parts.join(' ').trim();
  return `https://www.discogs.com/search/?q=${encodeURIComponent(query)}&type=release`;
};

export interface LinkageSplit {
  rotationLinked: NoMatchRow[];
  freeform: NoMatchRow[];
}

/**
 * Section A (catalog/rotation-linked, investigate in full) vs Section B
 * (freeform, aggregated). `rotation_id` is a serial PK -- never 0 -- so
 * `!= null` is the only "linked" test; no sentinel-value ambiguity.
 */
export const splitByLinkage = (rows: NoMatchRow[]): LinkageSplit => {
  const rotationLinked = rows.filter((row) => row.rotation_id != null);
  const freeform = rows.filter((row) => row.rotation_id == null);
  return { rotationLinked, freeform };
};

export interface ArtistGroup {
  artist: string;
  count: number;
}

export interface FreeformGrouping {
  top: ArtistGroup[];
  moreCount: number;
}

export const FREEFORM_TOP_N = 25;

/**
 * Max Section A (rotation-linked) lines rendered in full before collapsing to
 * a "…and N more" line. Bounds the email body even when the whole
 * `MAX_DIGEST_ROWS` result set is rotation-linked (a stalled-watermark
 * backlog); normal daily volume is far below this.
 */
export const SECTION_A_MAX = 200;

/**
 * Group freeform misses by artist, count desc (artist name asc as a
 * deterministic tiebreak), capped at `topN` with the remainder reported as
 * `moreCount` for the "…and X more" line.
 */
export const groupFreeformByArtist = (rows: NoMatchRow[], topN: number = FREEFORM_TOP_N): FreeformGrouping => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const artist = row.artist_name?.trim() || 'Unknown artist';
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .map(([artist, count]) => ({ artist, count }))
    .sort((a, b) => b.count - a.count || a.artist.localeCompare(b.artist));
  return { top: sorted.slice(0, topN), moreCount: Math.max(0, sorted.length - topN) };
};

/** `WXYC metadata gaps: {N} playcut(s) with no match — {YYYY-MM-DD}` (date in PT). */
export const buildSubject = (count: number, runStart: Date): string =>
  `WXYC metadata gaps: ${count} playcut${count === 1 ? '' : 's'} with no match — ${formatPacificDate(runStart)}`;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const formatRotationLine = (row: NoMatchRow): { label: string; url: string } => {
  const artist = row.artist_name ?? 'Unknown artist';
  const track = row.track_title ?? 'Unknown track';
  const album = row.album_title ?? 'Unknown album';
  const label = row.record_label ?? 'Unknown label';
  const dj = row.dj_name ?? 'Unknown DJ';
  const show = row.show_name ?? 'Unknown show';
  const startLabel = row.start_time ? ` ${formatPacificDateTime(row.start_time)}` : '';
  return {
    label: `#${row.id} · ${artist} — ${track} · ${album} · ${label} · DJ ${dj} · ${show}${startLabel}`,
    url: synthesizeDiscogsSearchUrl(row.artist_name, row.track_title),
  };
};

export interface DigestEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface BuildDigestOptions {
  /** Watermark window start (exclusive) -- the previous run's `cronjob_runs.last_run`, or the first-run 24h floor. */
  since: Date;
  /** This run's captured start instant; also the value the watermark advances to on success. */
  runStart: Date;
  /** Freeform artist-group cap before "…and X more" (default `FREEFORM_TOP_N`). */
  topN?: number;
  /** True when the query hit `MAX_DIGEST_ROWS` -- the counts below are of the loaded subset, not the full window; the header flags this. */
  truncated?: boolean;
  /** Section A (rotation-linked) render cap before "…and N more" (default `SECTION_A_MAX`). */
  sectionAMax?: number;
}

/**
 * Render the full digest email, or `null` for a zero-row run -- the caller
 * (`job.ts`) skips sending entirely and still advances the watermark. Never
 * throws on missing/null fields; every column renders a graceful fallback.
 */
export const buildDigestEmail = (rows: NoMatchRow[], options: BuildDigestOptions): DigestEmailContent | null => {
  if (rows.length === 0) return null;

  const { since, runStart, topN = FREEFORM_TOP_N, truncated = false, sectionAMax = SECTION_A_MAX } = options;
  const { rotationLinked, freeform } = splitByLinkage(rows);
  const { top, moreCount } = groupFreeformByArtist(freeform, topN);

  const subject = buildSubject(rows.length, runStart);
  const sinceLabel = formatPacificDateTime(since);
  const runStartLabel = formatPacificDateTime(runStart);
  const countPrefix = truncated ? `${rows.length}+` : `${rows.length}`;
  const cappedNote = truncated
    ? ' (result set capped at the row limit — the digest window may be backed up; counts are of the loaded subset.)'
    : '';
  const header = `${countPrefix} total since ${sinceLabel} — ${rotationLinked.length} catalog/rotation-linked, ${freeform.length} freeform.${cappedNote}`;

  const rotationShown = rotationLinked.slice(0, sectionAMax);
  const rotationOmitted = Math.max(0, rotationLinked.length - sectionAMax);
  const rotationLines = rotationShown.map(formatRotationLine);
  const rotationMoreLine =
    rotationOmitted > 0 ? `…and ${rotationOmitted} more catalog/rotation-linked (omitted)` : null;
  const freeformLines = top.map(({ artist, count }) => ({
    label: `${artist} — ${count} play${count === 1 ? '' : 's'}`,
    url: synthesizeDiscogsSearchUrl(artist, null),
  }));
  const moreLine = moreCount > 0 ? `…and ${moreCount} more` : null;

  const footer = [
    `Window: ${sinceLabel} → ${runStartLabel}.`,
    'Reply to this email to follow up on any of these.',
  ].join(' ');

  const textLines: string[] = [
    header,
    '',
    'Section A — Catalog/rotation-linked (investigate):',
    ...(rotationLines.length > 0 ? rotationLines.map(({ label, url }) => `  ${label} (${url})`) : ['  None.']),
    ...(rotationMoreLine ? [`  ${rotationMoreLine}`] : []),
    '',
    'Section B — Freeform:',
    ...(freeformLines.length > 0 ? freeformLines.map(({ label, url }) => `  ${label} (${url})`) : ['  None.']),
    ...(moreLine ? [`  ${moreLine}`] : []),
    '',
    footer,
  ];
  const text = textLines.join('\n');

  const htmlRotationItems =
    rotationLines.length > 0
      ? rotationLines
          .map(({ label, url }) => `<li>${escapeHtml(label)} — <a href="${url}">Discogs search</a></li>`)
          .join('') + (rotationMoreLine ? `<li>${escapeHtml(rotationMoreLine)}</li>` : '')
      : '<li>None.</li>';
  const htmlFreeformItems =
    freeformLines.length > 0
      ? freeformLines
          .map(({ label, url }) => `<li>${escapeHtml(label)} — <a href="${url}">Discogs search</a></li>`)
          .join('') + (moreLine ? `<li>${escapeHtml(moreLine)}</li>` : '')
      : '<li>None.</li>';

  const html = [
    `<p>${escapeHtml(header)}</p>`,
    '<h2>Section A — Catalog/rotation-linked (investigate)</h2>',
    `<ul>${htmlRotationItems}</ul>`,
    '<h2>Section B — Freeform</h2>',
    `<ul>${htmlFreeformItems}</ul>`,
    `<p>${escapeHtml(footer)}</p>`,
  ].join('\n');

  return { subject, html, text };
};
