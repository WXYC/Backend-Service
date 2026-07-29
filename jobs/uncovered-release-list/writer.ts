/**
 * Snapshot-file rendering + local write for jobs/uncovered-release-list
 * (BS#1877). The wire schema is a cross-repo contract — coordinated with
 * `WXYC/research-data#16` (the `search` crawl-mode ticket that consumes
 * this file) — and is LOCKED: exactly these three keys, one JSON object per
 * line, no trailing metadata:
 *
 *   {"artist": <canonical artist str>, "album": <canonical album str>, "library_id": <int>}
 *
 * `artist`/`album` are the library-canonical pair `rotation.ts` resolves
 * (never the raw rotation/tubafrenzy snapshot text) — this is the whole
 * point of ADR 0013's design: a search-sourced review row can be written
 * with the SAME canonical pair from the start, so
 * `album-critic-reviews-etl`'s exact-match resolver hits trivially,
 * without loosening it. `library_id` is `library.id`, the same key
 * `album_critic_reviews.album_id` FKs to.
 *
 * The file is plain UTF-8 text, LF-separated, with a trailing newline after
 * the last row (POSIX text-file convention) — empty input renders to an
 * empty string (a valid, meaningful "nothing uncovered this cycle"
 * snapshot, not an error).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CanonicalRelease } from './rotation.js';

/** The locked wire shape — see the module docstring. Key order matches the
 *  contract exactly; JSON.stringify preserves insertion order for string
 *  keys, so this object literal's field order IS the file's field order. */
export interface UncoveredReleaseRow {
  artist: string;
  album: string;
  library_id: number;
}

export const toSnapshotRow = (release: CanonicalRelease): UncoveredReleaseRow => ({
  artist: release.artist,
  album: release.album,
  library_id: release.libraryId,
});

/** Pure: render the full file content for a set of releases. Never throws;
 *  a caller with zero releases gets an empty string, not a single blank line. */
export const renderSnapshot = (releases: readonly CanonicalRelease[]): string =>
  releases.length === 0 ? '' : releases.map((release) => JSON.stringify(toSnapshotRow(release))).join('\n') + '\n';

/** Default output path, relative to the job's cwd (the container's
 *  `/uncovered-release-list` WORKDIR in production). `OUTPUT_PATH` lets an
 *  operator (or a test) redirect it. */
export const resolveOutputPath = (raw: string | undefined = process.env.OUTPUT_PATH): string =>
  raw && raw.trim().length > 0 ? raw.trim() : './output/uncovered-releases.jsonl';

/** Write pre-rendered `content` to `path`, creating parent directories as
 *  needed. Split from `renderSnapshot` so orchestrate.ts can render once and
 *  hand the same string to both this writer and `publish.ts` — the file on
 *  disk and the content pushed to research-data are byte-identical by
 *  construction, never independently derived. */
export const writeSnapshotFile = async (content: string, path: string): Promise<{ path: string }> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { path };
};
