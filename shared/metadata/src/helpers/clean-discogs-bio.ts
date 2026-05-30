/**
 * Strip Discogs markup tags from bio text.
 *
 * Discogs profiles use custom markup like `[a=Artist]`, `[l=Label]`,
 * `[r=Release]`, `[m=Master]`, `[url=...]...[/url]`. This converts them
 * to plain text so the iOS playcut detail view doesn't render the raw
 * tags.
 */
export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');
