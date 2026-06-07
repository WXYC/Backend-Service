/**
 * Strip Discogs markup tags from bio text.
 *
 * Discogs profiles use two flavours of entity markup:
 *   - Named: `[a=Artist]`, `[l=Label]`, `[r=Release]`, `[m=Master]` — Discogs
 *     renders these as the inline name, so we keep the inner text.
 *   - Numeric-id: `[a8390436]`, `[l123]`, `[r45]`, `[m999]` — Discogs resolves
 *     these to the entity name in its own UI. LML hands them through verbatim,
 *     so we drop the token (a name-resolving round-trip is out of scope for a
 *     string helper) and clean up the punctuation left behind.
 * Plus `[url=...]text[/url]` which collapses to the visible text.
 *
 * Without this, iOS's playcut detail view renders the raw tokens.
 */
export const cleanDiscogsBio = (bio: string): string =>
  bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2')
    .replace(/,?\s*\[(?:a|l|r|m)\d+\]/g, '')
    .replace(/ +/g, ' ')
    .trim();
