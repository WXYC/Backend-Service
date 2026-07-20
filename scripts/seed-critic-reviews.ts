/**
 * Seed `album_critic_reviews` with short attributed critic-review snippets
 * (album-critic-reviews slice, ADR 0012).
 *
 * This is the write-side companion to the read path
 * `lookupCriticReviewsByAlbumKey` (apps/backend/services/album-metadata-lookup.service.ts).
 * It takes a prepared manifest of candidate review articles, resolves each to
 * a linked library album via the SAME normalized flowsheet lookup key the
 * serve path uses (so a seeded row is guaranteed reachable by the endpoint),
 * asks Claude Haiku to pull ONE short verbatim excerpt + attribution, and
 * UPSERTs into `album_critic_reviews` keyed on `(album_id, source_url)`.
 *
 * Sources (the user's "(a) and (b)" scope):
 *   (b1) the existing crawled review corpus (WXYC/research-data — ~37K
 *        articles from 4 publications), and
 *   (b2) structured critic-review relations (e.g. MusicBrainz review URLs).
 * Corpus *discovery* (crawling research-data, querying MB) is deliberately
 * OUT of this tracer-bullet script — that belongs in a future
 * `jobs/album-critic-reviews-etl/`. This script reads a already-assembled
 * manifest so the load-bearing parts (LLM extraction + idempotent write +
 * album linkage) are real and reviewable now. Both sources normalize to the
 * common `CorpusItem` shape below before they reach this script.
 *
 * Fair use (see ADR 0012): we store a SHORT attributed excerpt (<=300 chars)
 * plus a mandatory link-out to the full review — never full text, never a
 * score-only card. The 300-char cap is enforced in code (`MAX_SNIPPET`), not
 * just in the prompt, so a mis-behaving model can't overshoot it.
 *
 * SAFETY — this script costs money (Anthropic API) and writes to a live DB:
 *   - DRY RUN IS THE DEFAULT. Nothing is written unless SEED_EXECUTE=true.
 *   - SEED_SKIP_LLM=true swaps the Haiku call for a deterministic local
 *     first-sentence excerpt so the pipeline can be exercised end-to-end at
 *     ZERO API cost (lower quality — validation only, not for production seed).
 *   - With the LLM enabled, ANTHROPIC_API_KEY must be set or the script aborts
 *     up front rather than silently degrading.
 *
 * Usage:
 *   # zero-cost pipeline smoke (no writes, no API):
 *   SEED_SKIP_LLM=true dotenvx run -f .env -- npx tsx scripts/seed-critic-reviews.ts --input reviews.jsonl
 *
 *   # real extraction, still no writes (preview what would be seeded):
 *   dotenvx run -f .env -- npx tsx scripts/seed-critic-reviews.ts --input reviews.jsonl
 *
 *   # commit to the DB:
 *   SEED_EXECUTE=true dotenvx run -f .env -- npx tsx scripts/seed-critic-reviews.ts --input reviews.jsonl
 *
 * Requires (only for real extraction): `npm i @anthropic-ai/sdk` — the SDK is
 * loaded via dynamic import so the SEED_SKIP_LLM path runs without it present.
 *
 * Input manifest: JSONL, one CorpusItem per line (see the type below).
 *   {"artist":"Juana Molina","album":"DOGA","source":"Pitchfork",
 *    "sourceUrl":"https://pitchfork.com/reviews/albums/juana-molina-doga/",
 *    "articleText":"...full review body...","author":"Philip Sherburne",
 *    "publishedAt":"2024-09-30","rating":"7.8"}
 */

import { config } from 'dotenv';
config();

import { readFileSync } from 'node:fs';
import { sql, desc } from 'drizzle-orm';
import { db, closeDatabaseConnection, flowsheet, album_critic_reviews } from '@wxyc/database';

/** One candidate review, normalized from either source (b1) or (b2). */
export interface CorpusItem {
  /** Artist as it should match the WXYC flowsheet/library artist_name. */
  artist: string;
  /** Album title as it should match the flowsheet/library album_title. */
  album: string;
  /** Publication name shown as the snippet's attribution (e.g. "Pitchfork"). */
  source: string;
  /** Canonical URL of the full review — the mandatory link-out + conflict key. */
  sourceUrl: string;
  /** Full review body Haiku reads to pull the excerpt from. */
  articleText: string;
  /** Byline, if the manifest already knows it (Haiku may also recover it). */
  author?: string;
  /** ISO date (YYYY-MM-DD) the review was published, if known. */
  publishedAt?: string;
  /** Score as printed by the publication (e.g. "7.8", "4/5"), if any. */
  rating?: string;
  /** Discogs release id, if the manifest carries one (informational only). */
  discogsReleaseId?: number;
}

/** What Haiku returns per article, before we cap/clean it. */
interface Extraction {
  /** False when the article isn't actually a review of this album — skip it. */
  isReview: boolean;
  /** One verbatim excerpt from the body, the reviewer's own words. */
  snippet: string;
  /** Byline recovered from the body, or null. */
  author: string | null;
  /** Score recovered from the body, or null. */
  rating: string | null;
}

/** Hard fair-use ceiling. The DB column is varchar(512); we self-limit tighter. */
const MAX_SNIPPET = 300;
const MODEL = 'claude-haiku-4-5-20251001';

const DRY_RUN = process.env.SEED_EXECUTE !== 'true';
const SKIP_LLM = process.env.SEED_SKIP_LLM === 'true';
const LIMIT = Number.parseInt(process.env.SEED_LIMIT ?? '0', 10); // 0 = no cap

function parseArgs(argv: string[]): { input: string } {
  const idx = argv.indexOf('--input');
  const input = idx >= 0 ? argv[idx + 1] : process.env.SEED_INPUT;
  if (!input) {
    console.error('❌ No input manifest. Pass --input <file.jsonl> or set SEED_INPUT.');
    process.exit(1);
  }
  return { input };
}

/** Read + parse the JSONL manifest, skipping blank lines. Throws on bad JSON. */
function loadManifest(path: string): CorpusItem[] {
  const raw = readFileSync(path, 'utf8');
  const items: CorpusItem[] = [];
  raw.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      items.push(JSON.parse(trimmed) as CorpusItem);
    } catch (err) {
      throw new Error(`Malformed JSON on line ${i + 1} of ${path}: ${(err as Error).message}`);
    }
  });
  return items;
}

/**
 * Resolve the linked library album_id for an (artist, album) pair using the
 * exact normalized key the serve path resolves against
 * (`resolveLinkedAlbumId` in album-metadata-lookup.service.ts). Kept in sync
 * by construction: same `lower(trim(...))` composition, same
 * `album_id IS NOT NULL` filter, same newest-row tiebreak. A review whose
 * album isn't linked in the flowsheet has nowhere to surface, so we skip it.
 */
async function resolveAlbumId(artist: string, album: string): Promise<number | null> {
  const trimmedArtist = artist.trim();
  const trimmedAlbum = album.trim();
  if (trimmedArtist.length === 0 || trimmedAlbum.length === 0) return null;

  const key = `${trimmedArtist.toLowerCase()}-${trimmedAlbum.toLowerCase()}`;
  const keyExpr = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

  const rows = await db
    .select({ album_id: flowsheet.album_id })
    .from(flowsheet)
    .where(sql`${keyExpr} = ${key} AND ${flowsheet.album_id} IS NOT NULL`)
    .orderBy(desc(flowsheet.id))
    .limit(1);

  return rows[0]?.album_id ?? null;
}

const EXTRACTION_SYSTEM = [
  'You extract a single short, verbatim, attributable pull-quote from a music album review.',
  'Rules:',
  `- The snippet MUST be the reviewer's own words, copied verbatim from the body, and <= ${MAX_SNIPPET} characters.`,
  '- Prefer an evaluative sentence about the music (not a plot/biography sentence).',
  '- Do NOT paraphrase, summarize, translate, or invent text. If nothing suitable exists, set isReview=false.',
  '- If the article is not actually a review of the named album, set isReview=false.',
  '- Recover the byline (author) and the printed score (rating) only if they appear in the text; otherwise null.',
].join('\n');

/** JSON-schema tool the model is forced to call, so output is structured. */
const EXTRACTION_TOOL = {
  name: 'record_snippet',
  description: 'Record the extracted pull-quote and attribution.',
  input_schema: {
    type: 'object',
    properties: {
      isReview: {
        type: 'boolean',
        description: 'True only if this is a review of the named album with a usable quote.',
      },
      snippet: {
        type: 'string',
        description: `Verbatim excerpt, <= ${MAX_SNIPPET} chars. Empty string if isReview is false.`,
      },
      author: { type: ['string', 'null'], description: 'Byline if present in the text, else null.' },
      rating: { type: ['string', 'null'], description: 'Printed score if present, else null.' },
    },
    required: ['isReview', 'snippet', 'author', 'rating'],
    additionalProperties: false,
  },
} as const;

// The Anthropic client is loaded lazily so the SEED_SKIP_LLM path needs no SDK.
// Typed loosely on purpose — scripts/ is outside the typecheck + lint scope.
/* eslint-disable @typescript-eslint/no-explicit-any */
let anthropicClient: any = null;

async function getAnthropic(): Promise<any> {
  if (anthropicClient) return anthropicClient;
  // Computed specifier keeps a missing optional dep from being a hard
  // dependency of this file when SEED_SKIP_LLM is used.
  const moduleName = '@anthropic-ai/sdk';
  const mod: any = await import(moduleName);
  const Anthropic = mod.default ?? mod;
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

/**
 * Deterministic, zero-cost fallback used under SEED_SKIP_LLM: take the first
 * sentence of the article body, capped. Good enough to exercise the write
 * path; NOT the quality bar for a real seed.
 */
function localExtract(item: CorpusItem): Extraction {
  const body = item.articleText.replace(/\s+/g, ' ').trim();
  const firstSentence = body.split(/(?<=[.!?])\s/)[0] ?? body;
  const snippet = firstSentence.slice(0, MAX_SNIPPET).trim();
  return {
    isReview: snippet.length > 0,
    snippet,
    author: item.author ?? null,
    rating: item.rating ?? null,
  };
}

/** Ask Haiku for the structured extraction. Throws on a malformed tool call. */
async function llmExtract(item: CorpusItem): Promise<Extraction> {
  const client = await getAnthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: EXTRACTION_SYSTEM,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
    messages: [
      {
        role: 'user',
        content: [
          `Album: ${item.album}`,
          `Artist: ${item.artist}`,
          `Publication: ${item.source}`,
          '',
          'Review body:',
          item.articleText,
        ].join('\n'),
      },
    ],
  });

  const toolUse = (message.content ?? []).find((block: any) => block.type === 'tool_use');
  if (!toolUse) throw new Error('Model did not return a tool_use block');
  const out = toolUse.input as Partial<Extraction>;
  return {
    isReview: out.isReview === true,
    snippet: typeof out.snippet === 'string' ? out.snippet : '',
    author: typeof out.author === 'string' && out.author.trim().length > 0 ? out.author : null,
    rating: typeof out.rating === 'string' && out.rating.trim().length > 0 ? out.rating : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Normalize an extraction into a persistable row (or null to skip). Enforces
 * the fair-use cap in code: an over-length snippet is trimmed at the last
 * sentence/space boundary rather than mid-word, and a snippet that still can't
 * fit is rejected so we never persist a truncated-mid-thought quote.
 */
function toRow(
  item: CorpusItem,
  albumId: number,
  extraction: Extraction
): typeof album_critic_reviews.$inferInsert | null {
  if (!extraction.isReview) return null;
  let snippet = extraction.snippet.replace(/\s+/g, ' ').trim();
  if (snippet.length === 0) return null;
  if (snippet.length > MAX_SNIPPET) {
    const cut = snippet.slice(0, MAX_SNIPPET);
    const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
    snippet = boundary > MAX_SNIPPET * 0.6 ? cut.slice(0, boundary).trim() : '';
    if (snippet.length === 0) return null; // couldn't cap cleanly — drop it
  }
  return {
    album_id: albumId,
    source: item.source,
    source_url: item.sourceUrl,
    snippet,
    author: extraction.author ?? item.author ?? null,
    published_at: item.publishedAt ?? null,
    rating: extraction.rating ?? item.rating ?? null,
    discogs_release_id: item.discogsReleaseId ?? null,
    source_key: `manifest:${item.source}`,
  };
}

/** Idempotent UPSERT on the (album_id, source_url) unique index. */
async function upsertRow(row: typeof album_critic_reviews.$inferInsert): Promise<void> {
  await db
    .insert(album_critic_reviews)
    .values(row)
    .onConflictDoUpdate({
      target: [album_critic_reviews.album_id, album_critic_reviews.source_url],
      set: {
        source: row.source,
        snippet: row.snippet,
        author: row.author,
        published_at: row.published_at,
        rating: row.rating,
        discogs_release_id: row.discogs_release_id,
        source_key: row.source_key,
        last_modified: sql`now()`,
      },
    });
}

async function main(): Promise<void> {
  const { input } = parseArgs(process.argv.slice(2));

  if (!SKIP_LLM && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      '❌ ANTHROPIC_API_KEY is not set. Set it, or run with SEED_SKIP_LLM=true for the zero-cost local extractor.'
    );
    process.exit(1);
  }

  const all = loadManifest(input);
  const items = LIMIT > 0 ? all.slice(0, LIMIT) : all;

  console.log('🌱 Seed album_critic_reviews (ADR 0012)');
  console.log(`   Input: ${input} (${all.length} items${LIMIT > 0 ? `, capped to ${items.length}` : ''})`);
  console.log(`   Extractor: ${SKIP_LLM ? 'local first-sentence (zero cost)' : `Haiku (${MODEL})`}`);
  console.log(
    `   Mode: ${DRY_RUN ? 'DRY RUN (no writes) — set SEED_EXECUTE=true to commit' : '⚠️  EXECUTE (writing to DB)'}\n`
  );

  const stats = { written: 0, skippedUnlinked: 0, skippedNotReview: 0, failed: 0 };

  for (const item of items) {
    const label = `"${item.artist} — ${item.album}" (${item.source})`;
    try {
      const albumId = await resolveAlbumId(item.artist, item.album);
      if (albumId === null) {
        stats.skippedUnlinked++;
        console.log(`   ⤳ skip (no linked library album) ${label}`);
        continue;
      }

      const extraction = SKIP_LLM ? localExtract(item) : await llmExtract(item);
      const row = toRow(item, albumId, extraction);
      if (!row) {
        stats.skippedNotReview++;
        console.log(`   ⤳ skip (not a usable review) ${label}`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`   🔍 would upsert album_id=${albumId} ${label}\n        “${row.snippet}”`);
      } else {
        await upsertRow(row);
        console.log(`   ✅ upserted album_id=${albumId} ${label}`);
      }
      stats.written++;
    } catch (err) {
      stats.failed++;
      console.error(`   ❌ ${label} — ${(err as Error).message}`);
    }
  }

  console.log('\n📊 Seed complete:');
  console.log(`   ${DRY_RUN ? 'Would write' : 'Written'}:        ${stats.written}`);
  console.log(`   Skipped (unlinked): ${stats.skippedUnlinked}`);
  console.log(`   Skipped (no quote): ${stats.skippedNotReview}`);
  console.log(`   Failed:             ${stats.failed}`);

  await closeDatabaseConnection();
}

// Only run when invoked directly; tests import the helpers without side effects.
const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const arg = process.argv[1];
  return arg.endsWith('seed-critic-reviews.ts') || arg.endsWith('seed-critic-reviews.js');
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}
