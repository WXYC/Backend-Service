/**
 * Drives `computeCallNumber` from the shared call-number parity corpus
 * (WXYC/wxyc-shared `src/test-utils/call-number-cases.json`), vendored at
 * `tests/fixtures/call-number-cases.json` from a pinned wxyc-shared commit
 * (729990225c3f35de6d3362fd52190ca6e1eba0d0) with its SHA-256 beside it.
 * Bumping the pin is a deliberate re-vendor in this repo.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCallNumber, type LibraryResult } from '../../../../apps/backend/services/requestLine/types';

interface CorpusRow {
  id: string;
  genre: string | null;
  format: string | null;
  call_letters: string | null;
  artist_number: number | null;
  release_number: number | null;
  volume_letters: string | null;
  comp_letter: string | null;
  artist_name: string | null;
  full: string;
}

const FIXTURE = join(__dirname, '../../../fixtures/call-number-cases.json');
const raw = readFileSync(FIXTURE);
const rows: CorpusRow[] = JSON.parse(raw.toString('utf-8')).cases;

/** Rows this composer is known to fail, with why. Empty: every row passes. */
const KNOWN_DIVERGENCES: Record<string, string> = {};

function toLibraryResult(row: CorpusRow): LibraryResult {
  return {
    id: 1,
    title: null,
    artist: row.artist_name,
    codeLetters: row.call_letters,
    codeArtistNumber: row.artist_number,
    codeNumber: row.release_number,
    codeVolumeLetters: row.volume_letters,
    codeCompLetter: row.comp_letter,
    genre: row.genre,
    format: row.format,
  };
}

describe('call-number corpus', () => {
  it('matches its pinned SHA-256', () => {
    const pinned = readFileSync(`${FIXTURE}.sha256`, 'utf-8').split(/\s+/)[0];
    expect(createHash('sha256').update(raw).digest('hex')).toBe(pinned);
  });

  it('lists only rows that exist in the corpus', () => {
    const ids = new Set(rows.map((r) => r.id));
    expect(Object.keys(KNOWN_DIVERGENCES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it.each(rows.map((row) => [row.id, row] as const))('%s', (id, row) => {
    const actual = computeCallNumber(toLibraryResult(row));
    if (id in KNOWN_DIVERGENCES) {
      expect(actual).not.toBe(row.full);
    } else {
      expect(actual).toBe(row.full);
    }
  });
});
