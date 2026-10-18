import { and, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, intake_items } from '@wxyc/database';
import { checkStreamingAvailability, isLmlConfigured } from '@wxyc/lml-client';

/**
 * The listen-first links (BS#3391): asks LML's streaming-check for a record's Spotify, Apple Music and Bandcamp links and stores
 * what it finds in one UPDATE. Deezer is ignored, since the station does not link it. Called after the commit and not awaited, so
 * it never throws and never holds a response: an LML error leaves the item as it was.
 *
 * With `namesChanged` the found links are replaced outright (null where LML found none), so a renamed record never keeps another
 * record's link; otherwise a link is written only where the column is null. A music director's Bandcamp link
 * (`bandcamp_url_entered`) is kept either way. The UPDATE names the looked-up names in its `WHERE`, so an answer for a record
 * renamed again meanwhile is dropped rather than stored under the new names.
 */
export const lookUpIntakeLinks = async (
  item: { id: number; artist_name: string; album_title: string },
  namesChanged: boolean
): Promise<void> => {
  if (!isLmlConfigured()) {
    return;
  }
  try {
    const { sources } = await checkStreamingAvailability(item.artist_name, item.album_title, {
      caller: 'intake-streaming-links',
    });
    const keepOrFill = (column: AnyPgColumn, url: string | undefined) =>
      namesChanged ? (url ?? null) : sql`coalesce(${column}, ${url ?? null})`;
    await db
      .update(intake_items)
      .set({
        spotify_url: keepOrFill(intake_items.spotify_url, sources.spotify?.url),
        apple_music_url: keepOrFill(intake_items.apple_music_url, sources.apple_music?.url),
        bandcamp_url: sql`CASE WHEN ${intake_items.bandcamp_url_entered} THEN ${intake_items.bandcamp_url} ELSE ${
          namesChanged
            ? sql`${sources.bandcamp?.url ?? null}`
            : sql`coalesce(${intake_items.bandcamp_url}, ${sources.bandcamp?.url ?? null})`
        } END`,
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
