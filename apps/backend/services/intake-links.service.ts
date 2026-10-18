import { and, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, intake_items } from '@wxyc/database';
import {
  checkStreamingAvailability,
  hasUrlParserDifferentialChar,
  isAppleMusicUrl,
  isBandcampUrl,
  isLmlConfigured,
  isSpotifyAlbumSlotUrl,
  type StreamingCheckResponse,
} from '@wxyc/lml-client';
import { getPostHogClient } from '../utils/posthog.js';

/** What the lookup needs of an item: its id and the names it is looked up by. */
type IntakeLinkSubject = { id: number; artist_name: string; album_title: string };

/** The width of the three `varchar(512)` link columns: a longer URL would fail the whole UPDATE. */
const LINK_URL_MAX = 512;

/**
 * An LML URL as it may be stored, or `null` (BS#3391). The streaming-check's sources are not screened by the client, so each one gets
 * the #1712 field check (`isSpotifyAlbumSlotUrl`, `isAppleMusicUrl`, `isBandcampUrl`, which leaves Bandcamp's custom-domain storefronts
 * in) plus the bar the entered Bandcamp link meets: no backslash, space or control character (`hasUrlParserDifferentialChar`), `https`,
 * no credentials, and at most 512 characters.
 */
export const screenLinkUrl = (
  url: string | null | undefined,
  isServiceUrl: (url: string) => boolean
): string | null => {
  if (typeof url !== 'string' || url.length > LINK_URL_MAX || hasUrlParserDifferentialChar(url)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || !isServiceUrl(url)) {
    return null;
  }
  return url;
};

/**
 * The streaming-check's partial-error telemetry, as the library filing service sends it (BS#1228): one PostHog
 * `streaming_check_partial_error` event when some services errored, so the rate of incomplete lookups stays visible. A PostHog failure is
 * a `console.warn`, never a thrown error.
 */
const reportPartialError = (item: IntakeLinkSubject, result: StreamingCheckResponse) => {
  if (!result.errored_sources?.length) {
    return;
  }
  try {
    getPostHogClient().capture({
      distinctId: `intake_item:${item.id}`,
      event: 'streaming_check_partial_error',
      properties: {
        caller: 'intake-streaming-links',
        intake_item_id: item.id,
        artist: item.artist_name,
        title: item.album_title,
        on_streaming_verdict: result.on_streaming,
        errored_sources: result.errored_sources,
      },
    });
  } catch (error) {
    console.warn('Failed to emit streaming-check telemetry:', (error as Error).message);
  }
};

/**
 * The listen-first links (BS#3391): asks LML's streaming-check for a record's Spotify, Apple Music and Bandcamp links and stores what
 * it finds in one UPDATE. Deezer is ignored, since the station does not link it. Called after the commit and not awaited, so it never
 * throws and never holds a response: an LML error leaves the item as it was.
 *
 * A link is written only where the column is null, and a music director's Bandcamp link (`bandcamp_url_entered`) is never replaced. A
 * rename has already cleared the found links in the PATCH's own UPDATE (`buildIntakePatch`), so this only fills. The UPDATE names the
 * looked-up names in its `WHERE`, so an answer for a record renamed meanwhile is dropped rather than stored under the new names.
 */
export const lookUpIntakeLinks = async (item: IntakeLinkSubject): Promise<void> => {
  if (!isLmlConfigured()) {
    return;
  }
  try {
    const result = await checkStreamingAvailability(item.artist_name, item.album_title, {
      caller: 'intake-streaming-links',
    });
    reportPartialError(item, result);
    const { sources } = result;
    const fill = (column: AnyPgColumn, url: string | null | undefined, isServiceUrl: (url: string) => boolean) =>
      sql`coalesce(${column}, ${screenLinkUrl(url, isServiceUrl)})`;
    await db
      .update(intake_items)
      .set({
        spotify_url: fill(intake_items.spotify_url, sources.spotify?.url, isSpotifyAlbumSlotUrl),
        apple_music_url: fill(intake_items.apple_music_url, sources.apple_music?.url, isAppleMusicUrl),
        bandcamp_url: sql`CASE WHEN ${intake_items.bandcamp_url_entered} THEN ${intake_items.bandcamp_url} ELSE ${fill(
          intake_items.bandcamp_url,
          sources.bandcamp?.url,
          isBandcampUrl
        )} END`,
        links_checked_at: sql`now()`,
      })
      .where(
        and(
          eq(intake_items.id, item.id),
          eq(intake_items.artist_name, item.artist_name),
          eq(intake_items.album_title, item.album_title)
        )
      );
  } catch (error) {
    console.warn('Intake link lookup failed:', (error as Error).message);
  }
};
