/**
 * Haiku snippet extraction for album-critic-reviews-etl (BS#1830). Lifted
 * from `scripts/seed-critic-reviews.ts` (NOT imported — that script
 * transitively pulls `apps/backend`, which would break this job's Docker
 * build stage, since each job's Dockerfile copies only the job dir +
 * `@wxyc/database`).
 *
 * `@anthropic-ai/sdk` is a REAL dependency here (unlike the seed script's
 * dynamic `import()`, used there to avoid a hard dependency on a package no
 * other `package.json` declared). `llmExtract` takes an injectable client
 * (any object shaping `{ messages: { create(...) } }`) so unit tests never
 * construct a real `Anthropic` instance; `job.ts` wires the real one.
 *
 * `buildRow`'s cap/boundary-trim logic is a verbatim port of the seed
 * script's `toRow`, with ONE deliberate change: author precedence is
 * REVERSED. The issue: "Manifest `author` wins over the LLM-guessed author
 * when present." The seed script had `extraction.author ?? item.author`
 * (LLM wins); this job does `item.author ?? extraction.author` (manifest
 * wins). Rating precedence is UNCHANGED from the seed script
 * (`extraction.rating ?? item.rating`) — the issue only calls out author.
 */
import type { album_critic_reviews } from '@wxyc/database';
import type { CorpusItem } from './manifest.js';

/** Hard fair-use ceiling (ADR 0012). The DB column is varchar(512); this
 *  writer self-limits tighter and enforces it in code, not just the prompt. */
export const MAX_SNIPPET = 300;

/** Column ceilings from migration 0125. Enforced in code so an over-length
 *  LLM-recovered byline/score or a pathological manifest URL can't overflow
 *  the varchar at insert time and abort the whole run — the write path is
 *  isolated per-item (orchestrate.ts), but keeping garbage out of the row in
 *  the first place preserves the card instead of dropping it as a write
 *  error. `author`/`rating` are attribution niceties: null an over-length
 *  value, keep the review. `source_url` is load-bearing (link-out target +
 *  half the natural key) and can't be truncated safely, so reject the row. */
export const MAX_AUTHOR = 128;
export const MAX_RATING = 32;
export const MAX_SOURCE_URL = 1024;
export const MODEL = 'claude-haiku-4-5-20251001';

export const EXTRACTION_SYSTEM = [
  'You extract a single short, verbatim, attributable pull-quote from a music album review.',
  'Rules:',
  `- The snippet MUST be the reviewer's own words, copied verbatim from the body, and <= ${MAX_SNIPPET} characters.`,
  '- Prefer an evaluative sentence about the music (not a plot/biography sentence).',
  '- Do NOT paraphrase, summarize, translate, or invent text. If nothing suitable exists, set isReview=false.',
  '- If the article is not actually a review of the named album, set isReview=false.',
  '- Recover the byline (author) and the printed score (rating) only if they appear in the text; otherwise null.',
].join('\n');

/** JSON-schema tool the model is forced to call, so output is structured. */
export const EXTRACTION_TOOL = {
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

/** What Haiku returns per article, before it's capped/cleaned. */
export interface Extraction {
  /** False when the article isn't actually a review of this album — skip it. */
  isReview: boolean;
  /** One verbatim excerpt from the body, the reviewer's own words. */
  snippet: string;
  /** Byline recovered from the body, or null. */
  author: string | null;
  /** Score recovered from the body, or null. */
  rating: string | null;
}

/** Minimal shape `llmExtract` needs from an Anthropic client — narrow on
 *  purpose so tests inject a fake without constructing a real SDK client. */
export interface AnthropicLike {
  messages: {
    create(params: unknown): Promise<{ content?: Array<{ type: string; input?: unknown }> }>;
  };
}

/** Ask Haiku for the structured extraction. Throws on a malformed tool
 *  call — the caller (orchestrate.ts) catches per-item so one poisoned
 *  article can't wedge the whole run. */
export const llmExtract = async (item: CorpusItem, client: AnthropicLike): Promise<Extraction> => {
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

  const toolUse = (message.content ?? []).find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('Model did not return a tool_use block');
  const out = toolUse.input as Partial<Extraction>;
  return {
    isReview: out.isReview === true,
    snippet: typeof out.snippet === 'string' ? out.snippet : '',
    author: typeof out.author === 'string' && out.author.trim().length > 0 ? out.author : null,
    rating: typeof out.rating === 'string' && out.rating.trim().length > 0 ? out.rating : null,
  };
};

/**
 * Normalize an extraction into a persistable row (or null to skip).
 * Enforces the fair-use cap in code: an over-length snippet is trimmed at
 * the last sentence/space boundary rather than mid-word, and a snippet that
 * still can't fit past 60% of the cap is rejected so a truncated-mid-thought
 * quote is never persisted.
 */
export const buildRow = (
  item: CorpusItem,
  albumId: number,
  extraction: Extraction
): typeof album_critic_reviews.$inferInsert | null => {
  if (!extraction.isReview) return null;
  let snippet = extraction.snippet.replace(/\s+/g, ' ').trim();
  if (snippet.length === 0) return null;
  if (snippet.length > MAX_SNIPPET) {
    const cut = snippet.slice(0, MAX_SNIPPET);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    const wordEnd = cut.lastIndexOf(' ');
    if (sentenceEnd > MAX_SNIPPET * 0.6) {
      snippet = cut.slice(0, sentenceEnd + 1).trim();
    } else if (wordEnd > MAX_SNIPPET * 0.6) {
      snippet = cut.slice(0, wordEnd).trim();
    } else {
      snippet = '';
    }
    if (snippet.length === 0) return null; // couldn't cap cleanly — drop it
  }
  // The link-out target can't be truncated without breaking it, and it's half
  // the natural key — reject rather than store a mangled URL.
  if (item.sourceUrl.length > MAX_SOURCE_URL) return null;

  // REVERSED from the seed script: manifest author wins when present
  // (issue's explicit instruction).
  const author = item.author ?? extraction.author ?? null;
  // Unchanged from the seed script: extraction (LLM-recovered) rating wins.
  const rating = extraction.rating ?? item.rating ?? null;
  return {
    album_id: albumId,
    source: item.source,
    source_url: item.sourceUrl,
    snippet,
    // Null an over-length byline/score rather than overflow varchar(128)/(32):
    // the review + snippet stay usable, only the attribution field drops.
    author: author !== null && author.length <= MAX_AUTHOR ? author : null,
    published_at: item.publishedAt ?? null,
    rating: rating !== null && rating.length <= MAX_RATING ? rating : null,
    discogs_release_id: item.discogsReleaseId ?? null,
    source_key: `manifest:${item.source}`,
  };
};
