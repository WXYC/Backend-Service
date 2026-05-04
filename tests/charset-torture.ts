import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CharsetTortureEntry {
  category: string;
  input: string;
  expected_storage: string;
  expected_match_form: string | null;
  expected_ascii_form: string | null;
  notes: string;
}

interface CharsetTortureCorpus {
  meta: { description: string; version: number };
  categories: Record<string, Omit<CharsetTortureEntry, 'category'>[]>;
}

// __dirname works in CJS (jest) and is shimmed by ts-jest. Using it instead of
// import.meta.url keeps the loader importable from both jest and ESM contexts.
const corpusPath = resolve(__dirname, './fixtures/charset-torture.json');

const corpus: CharsetTortureCorpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));

export const CHARSET_TORTURE_ENTRIES: CharsetTortureEntry[] = Object.entries(corpus.categories).flatMap(
  ([category, entries]) => entries.map((e) => ({ ...e, category }))
);

export const charsetEntryId = (e: CharsetTortureEntry): string =>
  `${e.category}:${e.input.slice(0, 24).replace(/\n/g, '\\n')}`;
