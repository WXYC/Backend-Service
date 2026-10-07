-- rotation_cards.last_changed_at: when a card's membership last changed. Nullable with no default and
-- no backfill on purpose: a migration-time value would claim every card changed on deploy day, so a
-- card reads NULL until a rotation write touches it. The triggers that maintain it are in the next
-- migration; the column comment is there too, since drizzle does not model comments.
ALTER TABLE "wxyc_schema"."rotation_cards" ADD COLUMN "last_changed_at" timestamp with time zone;