/**
 * Manifest line parsing for album-critic-reviews-etl (BS#1830).
 *
 * `CorpusItem` is the cross-repo contract published by `WXYC/research-data`'s
 * `build_manifest.py` (one JSON object per line in `manifest.jsonl`,
 * distributed gzipped as the `manifest-latest` release's `manifest.jsonl.gz`
 * asset). Required: `artist`, `album` (raw, undecorated), `source`,
 * `sourceUrl`, `articleText`. Optional: `author`, `publishedAt` — omitted
 * from a line, never emitted as `null`, when the upstream builder couldn't
 * recover them. `rating` and `discogsReleaseId` are NOT emitted by the
 * current builder, but are kept on this type per the issue (the seed
 * script's `toRow` already reads them) so a future manifest revision that
 * adds them needs no ETL-side type change — they fall through to `null` at
 * the row-building boundary today.
 *
 * Pure, no I/O: `parseManifestLines` never throws on a malformed or
 * incomplete line — it counts it as `invalid` so the orchestrator's run
 * guard (zero-parsed) can fail the run loudly while individual bad lines
 * don't wedge the rest of a multi-thousand-line manifest.
 */

export interface CorpusItem {
  artist: string;
  album: string;
  source: string;
  sourceUrl: string;
  articleText: string;
  author?: string;
  publishedAt?: string;
  rating?: string;
  discogsReleaseId?: number;
}

const REQUIRED_STRING_FIELDS = ['artist', 'album', 'source', 'sourceUrl', 'articleText'] as const;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Validate a parsed JSON value as a CorpusItem. Returns the item (with
 *  optional fields present only when the source line carried them) or
 *  `null` when any required field is missing/empty. */
const toCorpusItem = (raw: unknown): CorpusItem | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(record[field])) return null;
  }

  const item: CorpusItem = {
    artist: record.artist as string,
    album: record.album as string,
    source: record.source as string,
    sourceUrl: record.sourceUrl as string,
    articleText: record.articleText as string,
  };
  if (isNonEmptyString(record.author)) item.author = record.author;
  if (isNonEmptyString(record.publishedAt)) item.publishedAt = record.publishedAt;
  if (isNonEmptyString(record.rating)) item.rating = record.rating;
  if (typeof record.discogsReleaseId === 'number') item.discogsReleaseId = record.discogsReleaseId;
  return item;
};

export interface ParsedManifest {
  items: CorpusItem[];
  /** Lines that were malformed JSON, not an object, or missing/empty a
   *  required field. Counted, never thrown — the orchestrator's run guard
   *  is what turns a wholesale-invalid manifest into a failed run. */
  invalid: number;
}

/** Parse a (decompressed) manifest.jsonl body. Blank lines are skipped
 *  silently (not counted as invalid) — they're formatting, not data. */
export const parseManifestLines = (jsonl: string): ParsedManifest => {
  const items: CorpusItem[] = [];
  let invalid = 0;

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      invalid += 1;
      continue;
    }

    const item = toCorpusItem(parsed);
    if (item === null) {
      invalid += 1;
      continue;
    }
    items.push(item);
  }

  return { items, invalid };
};
