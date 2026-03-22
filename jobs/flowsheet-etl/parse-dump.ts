/**
 * MySQL dump file parser for the flowsheet ETL bulk load mode.
 *
 * Reads INSERT lines from a MySQL dump and extracts value tuples.
 * Handles MySQL-style escaping in string literals.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RawShow, RawEntry } from './transform.js';

/**
 * Parse a single value tuple starting at `startIndex` (the character after '(').
 * Returns the parsed values and the index of the closing ')'.
 *
 * Handles:
 * - Single-quoted strings with MySQL escaping (\', \\, \n, \t)
 * - NULL literals
 * - Integer and bigint values
 */
export function parseTuple(
  input: string,
  startIndex: number
): { values: (string | number | null)[]; endIndex: number } {
  const values: (string | number | null)[] = [];
  let i = startIndex;

  while (i < input.length) {
    // Skip whitespace
    while (i < input.length && input[i] === ' ') i++;

    if (input[i] === ')') {
      return { values, endIndex: i };
    }

    // Skip comma between values
    if (input[i] === ',') {
      i++;
      continue;
    }

    // String value
    if (input[i] === "'") {
      i++; // skip opening quote
      let str = '';
      while (i < input.length) {
        if (input[i] === '\\') {
          i++;
          if (i < input.length) {
            switch (input[i]) {
              case "'":
                str += "'";
                break;
              case '\\':
                str += '\\';
                break;
              case 'n':
                str += '\n';
                break;
              case 't':
                str += '\t';
                break;
              case 'r':
                str += '\r';
                break;
              case '0':
                str += '\0';
                break;
              default:
                str += input[i];
                break;
            }
            i++;
          }
        } else if (input[i] === "'") {
          i++; // skip closing quote
          break;
        } else {
          str += input[i];
          i++;
        }
      }
      values.push(str);
      continue;
    }

    // NULL or number
    let token = '';
    while (i < input.length && input[i] !== ',' && input[i] !== ')') {
      token += input[i];
      i++;
    }
    token = token.trim();

    if (token === 'NULL') {
      values.push(null);
    } else {
      const num = Number(token);
      values.push(Number.isFinite(num) ? num : token);
    }
  }

  return { values, endIndex: i };
}

/**
 * Generator that yields parsed value arrays from a MySQL INSERT VALUES line.
 *
 * Example input:
 *   INSERT INTO `TABLE` VALUES (1,'a'),(2,'b');
 *
 * Yields: [1, 'a'], [2, 'b']
 */
export function* parseInsertValues(line: string): Generator<(string | number | null)[]> {
  const valuesIdx = line.indexOf(' VALUES (');
  if (valuesIdx === -1) return;

  let i = valuesIdx + ' VALUES '.length;

  while (i < line.length) {
    if (line[i] === '(') {
      const { values, endIndex } = parseTuple(line, i + 1);
      yield values;
      i = endIndex + 1;
    } else if (line[i] === ',' || line[i] === ';' || line[i] === ' ') {
      i++;
    } else {
      break;
    }
  }
}

const SHOW_TABLE = 'FLOWSHEET_RADIO_SHOW_PROD';
const ENTRY_TABLE = 'FLOWSHEET_ENTRY_PROD';

/**
 * Parse a MySQL dump file and extract shows and entries.
 *
 * Two-pass approach:
 * - Pass 1: collect shows (small dataset, ~71K rows)
 * - Pass 2: stream entries (large dataset, ~2.6M rows)
 *
 * Returns shows as an array and a generator function for entries to enable
 * batch processing without holding all entries in memory.
 */
export async function parseDumpShows(filePath: string): Promise<RawShow[]> {
  const shows: RawShow[] = [];
  const insertPrefix = `INSERT INTO \`${SHOW_TABLE}\` VALUES`;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.startsWith(insertPrefix)) continue;

    for (const values of parseInsertValues(line)) {
      // FLOWSHEET_RADIO_SHOW_PROD columns:
      // ID, STARTING_RADIO_HOUR, DJ_NAME, DJ_ID, DJ_HANDLE, SHOW_NAME,
      // SPECIALTY_SHOW_ID, WORKING_HOUR, SIGNON_TIME, SIGNOFF_TIME,
      // TIME_LAST_MODIFIED, TIME_CREATED, MODLOCK, SHOW_ID
      shows.push({
        id: values[0] as number,
        signon_time: values[8] as number,
        signoff_time: values[9] as number,
        show_name: (values[5] as string) ?? '',
      });
    }
  }

  return shows;
}

/**
 * Stream entries from a MySQL dump file, yielding batches.
 *
 * Entries are yielded in insertion order (dump is ordered by entry ID ≈ chronological).
 */
export async function* parseDumpEntries(
  filePath: string,
  batchSize: number = 5000
): AsyncGenerator<RawEntry[]> {
  const insertPrefix = `INSERT INTO \`${ENTRY_TABLE}\` VALUES`;
  let batch: RawEntry[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.startsWith(insertPrefix)) continue;

    for (const values of parseInsertValues(line)) {
      // FLOWSHEET_ENTRY_PROD columns:
      // ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
      // LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME,
      // STOP_TIME, RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG,
      // FLOWSHEET_ENTRY_TYPE_CODE_ID, TIME_LAST_MODIFIED, TIME_CREATED,
      // REQUEST_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER
      batch.push({
        id: values[0] as number,
        artist_name: (values[1] as string) ?? '',
        song_title: (values[3] as string) ?? '',
        release_title: (values[4] as string) ?? '',
        library_release_id: (values[6] as number) ?? 0,
        label_name: (values[8] as string) ?? '',
        radio_show_id: (values[12] as number) ?? 0,
        entry_type_code: (values[15] as number) ?? 0,
        time_created: (values[17] as number) ?? 0,
        request_flag: (values[18] as number) ?? 0,
      });

      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}
