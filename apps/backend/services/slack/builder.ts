/**
 * Slack message block builders for rich formatting.
 *
 * Ported from request-parser services/slack.py
 */

import { EnrichedLibraryResult, ArtworkResponse } from '../requestLine/types.js';

/**
 * Slack block type definitions.
 */
interface SlackTextBlock {
  type: 'mrkdwn' | 'plain_text';
  text: string;
}

interface SlackImageAccessory {
  type: 'image';
  image_url: string;
  alt_text: string;
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackTextBlock;
  accessory?: SlackImageAccessory;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextBlock[];
}

interface SlackDividerBlock {
  type: 'divider';
}

export type SlackBlock = SlackSectionBlock | SlackContextBlock | SlackDividerBlock;

/**
 * Build Slack message blocks from library results with artwork.
 *
 * @param message - Original request message
 * @param itemsWithArtwork - Library items paired with their artwork
 * @param context - Optional context message (e.g., "song not found, showing artist albums")
 */
export function buildSlackBlocks(
  message: string,
  itemsWithArtwork: Array<[EnrichedLibraryResult, ArtworkResponse | null]>,
  context?: string
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlackText(message)}*`,
      },
    },
  ];

  // Add context message if provided (e.g., "song not found, showing artist albums")
  if (context) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: context },
    });
  }

  for (const [item, artwork] of itemsWithArtwork) {
    // Build text with links to library and Discogs
    const textLines = [
      `*${escapeSlackText(item.artist || 'Unknown Artist')}*`,
      escapeSlackText(item.title || 'Unknown Title'),
      `_${escapeSlackText(item.callNumber)}_`,
    ];

    if (artwork && artwork.releaseUrl) {
      textLines.push(`<${artwork.releaseUrl}|Discogs> | <${item.libraryUrl}|WXYC>`);
    } else {
      textLines.push(`<${item.libraryUrl}|WXYC Library>`);
    }

    const block: SlackSectionBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: textLines.join('\n'),
      },
    };

    if (artwork && artwork.artworkUrl) {
      block.accessory = {
        type: 'image',
        image_url: artwork.artworkUrl,
        alt_text: `${item.title} album cover`,
      };
    }

    blocks.push(block);
  }

  return blocks;
}

/**
 * Build simple Slack message blocks for feedback or no-results messages.
 *
 * @param message - Original request message
 * @param context - Optional context message
 */
export function buildSimpleSlackBlocks(message: string, context?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlackText(message)}*`,
      },
    },
  ];

  if (context) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: context,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Escape special characters in text for Slack mrkdwn format.
 */
function escapeSlackText(text: string): string {
  // Escape &, <, > which have special meaning in Slack
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
