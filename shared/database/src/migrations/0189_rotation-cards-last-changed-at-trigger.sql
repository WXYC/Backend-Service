-- Keep rotation_cards.last_changed_at current from the writes that change a card's membership.
--
-- rotation.card_id and rotation.kill_date are written from the service layer (library.service.ts), the rotation-etl job and raw SQL, so
-- the stamp lives in the database rather than being repeated at every writer. One function, two row
-- triggers (Postgres forbids OLD in an INSERT trigger's WHEN, so INSERT/DELETE cannot share the
-- guarded UPDATE trigger):
--
--   * AFTER INSERT OR DELETE: stamps the card the row joins or leaves. OLD is NULL on INSERT and NEW
--     is NULL on DELETE, and IN ignores the NULL, so one statement serves both.
--   * AFTER UPDATE OF card_id, kill_date ... WHEN (changed): stamps the card the row left and the one
--     it joined, or the one it stays on across a kill or unkill. The WHEN guard is required because
--     UPDATE OF fires whenever the column is in the SET list, changed or not, and the rotation-etl
--     upsert lists kill_date = excluded.kill_date on every row it updates for any reason.
--
-- The ON DELETE SET NULL cascade from deleting a card fires the UPDATE trigger after the card row is
-- gone, so that stamp matches zero rows and raises nothing.
--
-- Lock order: the stamp locks the rotation row first and then the card(s). A card_id move A -> B
-- already locks B when the service resolves the destination card, and the stamp then locks A, so two
-- opposite moves (A -> B and B -> A) can deadlock. So can deleting a card (which locks the card, then
-- its rotation rows through the ON DELETE SET NULL cascade) against a kill, unkill, reschedule, move
-- or delete of a row on that card, and the legacy_move add (source card, then destination card)
-- against a PATCH move into the same destination card. Postgres detects each as 40P01 and aborts one
-- transaction. All need two music directors acting on the same card within milliseconds, so this is
-- accepted rather than engineered around.
--
-- @no-analyze-needed: the only UPDATE is a single-row stamp on rotation_cards per rotation write; it
-- is not a bulk update.
-- @no-precondition-needed: trigger and comment DDL only; no constraint and no data invariant.

CREATE OR REPLACE FUNCTION wxyc_schema.stamp_rotation_card_last_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE wxyc_schema.rotation_cards
  SET last_changed_at = now()
  WHERE id IN (OLD.card_id, NEW.card_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stamp_rotation_card_on_insert_delete ON wxyc_schema.rotation;
--> statement-breakpoint
CREATE TRIGGER stamp_rotation_card_on_insert_delete
AFTER INSERT OR DELETE ON wxyc_schema.rotation
FOR EACH ROW
EXECUTE FUNCTION wxyc_schema.stamp_rotation_card_last_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stamp_rotation_card_on_update ON wxyc_schema.rotation;
--> statement-breakpoint
CREATE TRIGGER stamp_rotation_card_on_update
AFTER UPDATE OF card_id, kill_date ON wxyc_schema.rotation
FOR EACH ROW
WHEN (OLD.card_id IS DISTINCT FROM NEW.card_id OR OLD.kill_date IS DISTINCT FROM NEW.kill_date)
EXECUTE FUNCTION wxyc_schema.stamp_rotation_card_last_changed();
--> statement-breakpoint
COMMENT ON COLUMN wxyc_schema.rotation_cards.last_changed_at IS 'The time a change to this card was recorded (a rotation row joined, left, was killed or unkilled on it), not the date that change names. NULL until the first such change after this column was added.';
