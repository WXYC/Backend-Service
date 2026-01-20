/**
 * AI Parser Service - Groq LLM integration for parsing song requests.
 *
 * Ported from request-parser services/parser.py
 */

import Groq from 'groq-sdk';
import { MessageType, ParsedRequest } from '../requestLine/types.js';
import { SYSTEM_PROMPT, formatUserPrompt } from './prompts.js';
import { getConfig } from '../requestLine/config.js';

/**
 * Groq client singleton.
 */
let _groqClient: Groq | null = null;

/**
 * Get or create the Groq client.
 */
function getGroqClient(): Groq {
  if (!_groqClient) {
    const config = getConfig();
    if (!config.groqApiKey) {
      throw new Error('GROQ_API_KEY is not configured');
    }
    _groqClient = new Groq({ apiKey: config.groqApiKey });
  }
  return _groqClient;
}

/**
 * Reset the Groq client (useful for testing).
 */
export function resetGroqClient(): void {
  _groqClient = null;
}

/**
 * Raw response from the AI parser.
 */
interface RawParsedResponse {
  song?: string | null;
  album?: string | null;
  artist?: string | null;
  is_request?: boolean;
  message_type?: string;
}

/**
 * Validate and normalize the message type from AI response.
 */
function normalizeMessageType(type: string | undefined): MessageType {
  if (!type) return MessageType.OTHER;
  const normalized = type.toLowerCase();
  switch (normalized) {
    case 'request':
      return MessageType.REQUEST;
    case 'dj_message':
      return MessageType.DJ_MESSAGE;
    case 'feedback':
      return MessageType.FEEDBACK;
    default:
      return MessageType.OTHER;
  }
}

/**
 * Parse a listener message and extract song request metadata.
 *
 * @param message - The raw listener message
 * @returns Parsed request with extracted metadata
 * @throws Error if Groq API fails or returns invalid response
 */
export async function parseRequest(message: string): Promise<ParsedRequest> {
  const config = getConfig();

  console.log(`[AI Parser] Parsing message: ${message.slice(0, 100)}...`);

  const client = getGroqClient();

  try {
    const response = await client.chat.completions.create({
      model: config.groqModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: formatUserPrompt(message) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from Groq');
    }

    const parsed: RawParsedResponse = JSON.parse(content);
    console.log(`[AI Parser] Raw parsed response:`, JSON.stringify(parsed));

    return {
      song: parsed.song ?? null,
      album: parsed.album ?? null,
      artist: parsed.artist ?? null,
      isRequest: parsed.is_request ?? false,
      messageType: normalizeMessageType(parsed.message_type),
      rawMessage: message,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`[AI Parser] Failed to parse JSON response:`, error);
      throw new Error(`Invalid JSON response from Groq: ${error.message}`);
    }
    console.error(`[AI Parser] Error parsing request:`, error);
    throw error;
  }
}

/**
 * Check if AI parsing is available.
 */
export function isParserAvailable(): boolean {
  const config = getConfig();
  return !!config.groqApiKey;
}
