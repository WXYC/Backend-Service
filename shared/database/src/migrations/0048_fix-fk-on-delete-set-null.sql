-- Fix FK constraints that were created with ON DELETE NO ACTION in migration 0021
-- but should be ON DELETE SET NULL to match the Drizzle schema.

-- @no-precondition-needed: each ALTER TABLE pair drops and re-adds the same
-- (column, references) FK with the same target columns and a different
-- ON DELETE action. Existing rows already satisfied the prior FK; the
-- referential predicate is unchanged, so the new ADD CONSTRAINT cannot
-- find an orphan that the old one missed. The DROP/ADD runs inside a
-- single migration transaction, so no concurrent write can introduce a
-- new orphan between the two statements.

ALTER TABLE wxyc_schema.schedule DROP CONSTRAINT schedule_assigned_dj_id_auth_user_id_fk;
ALTER TABLE wxyc_schema.schedule ADD CONSTRAINT schedule_assigned_dj_id_auth_user_id_fk FOREIGN KEY (assigned_dj_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;

ALTER TABLE wxyc_schema.schedule DROP CONSTRAINT schedule_assigned_dj_id2_auth_user_id_fk;
ALTER TABLE wxyc_schema.schedule ADD CONSTRAINT schedule_assigned_dj_id2_auth_user_id_fk FOREIGN KEY (assigned_dj_id2) REFERENCES public.auth_user(id) ON DELETE SET NULL;

ALTER TABLE wxyc_schema.shift_covers DROP CONSTRAINT shift_covers_cover_dj_id_auth_user_id_fk;
ALTER TABLE wxyc_schema.shift_covers ADD CONSTRAINT shift_covers_cover_dj_id_auth_user_id_fk FOREIGN KEY (cover_dj_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;

ALTER TABLE wxyc_schema.shows DROP CONSTRAINT shows_primary_dj_id_auth_user_id_fk;
ALTER TABLE wxyc_schema.shows ADD CONSTRAINT shows_primary_dj_id_auth_user_id_fk FOREIGN KEY (primary_dj_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;
