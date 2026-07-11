-- 0115 concerts.event_url (BS#1609)
-- Additive, nullable, DDL-only. Exposes the venue's own event-detail page on
-- the Concert read model (distinct from ticket_url, which is often a
-- third-party seller). Both scrapers already parse the value — the
-- venue-events-scraper from JSON-LD (`event_page_url`) and triangle-shows-etl
-- from the source EventResponse (`source_url`) — and refill this column on
-- their nightly UPSERT, so no backfill is required; rows with no known event
-- page stay NULL and clients fall back to ticket_url. No lock concern: ADD
-- COLUMN of a nullable column with no default is a metadata-only change.
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "event_url" text;
