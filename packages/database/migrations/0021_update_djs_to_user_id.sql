-- Migration to update DJs table to use user_id as primary key
-- This migration handles the transition from serial id to user_id as primary key

-- First, we need to update all foreign key references to use user_id instead of id
-- Update bins table
ALTER TABLE wxyc_schema.bins 
  ALTER COLUMN dj_id TYPE varchar(255);

-- Update schedule table  
ALTER TABLE wxyc_schema.schedule 
  ALTER COLUMN assigned_dj_id TYPE varchar(255),
  ALTER COLUMN assigned_dj_id2 TYPE varchar(255);

-- Update shift_covers table
ALTER TABLE wxyc_schema.shift_covers 
  ALTER COLUMN cover_dj_id TYPE varchar(255);

-- Update shows table
ALTER TABLE wxyc_schema.shows 
  ALTER COLUMN primary_dj_id TYPE varchar(255);

-- Update show_djs table
ALTER TABLE wxyc_schema.show_djs 
  ALTER COLUMN dj_id TYPE varchar(255);

-- Now we need to populate the new varchar columns with the actual user_id values
-- This assumes you have a way to map old dj.id values to user_id values
-- You may need to adjust this based on your data migration strategy

-- Update bins table with user_id values
-- UPDATE wxyc_schema.bins 
--   SET dj_id = (SELECT user_id FROM wxyc_schema.djs WHERE djs.id = bins.dj_id::integer);

-- Update schedule table with user_id values
-- UPDATE wxyc_schema.schedule 
--   SET assigned_dj_id = (SELECT user_id FROM wxyc_schema.djs WHERE djs.id = schedule.assigned_dj_id::integer)
--   WHERE assigned_dj_id IS NOT NULL;

-- UPDATE wxyc_schema.schedule 
--   SET assigned_dj_id2 = (SELECT user_id FROM wxyc_schema.djs WHERE djs.id = schedule.assigned_dj_id2::integer)
--   WHERE assigned_dj_id2 IS NOT NULL;

-- Update shift_covers table with user_id values
-- UPDATE wxyc_schema.shift_covers 
--   SET cover_dj_id = (SELECT user_id FROM wxyc_schema.djs WHERE djs.id = shift_covers.cover_dj_id::integer)
--   WHERE cover_dj_id IS NOT NULL;

-- Update shows table with user_id values
-- UPDATE wxyc_schema.shows 
--   SET primary_dj_id = (SELECT user_id FROM wxyc_schema.djs WHERE djs.id = shows.primary_dj_id::integer)
--   WHERE primary_dj_id IS NOT NULL;

-- Update show_djs table with user_id values
-- UPDATE wxyc_schema.show_djs 
--   SET dj_id = (SELECT user_id FROM wxyc_schema.djs WHERE djs.id = show_djs.dj_id::integer);

-- Drop the old id column from djs table
ALTER TABLE wxyc_schema.djs DROP COLUMN id;

-- Add foreign key constraints for the updated columns
ALTER TABLE wxyc_schema.bins 
  ADD CONSTRAINT bins_dj_id_fkey FOREIGN KEY (dj_id) REFERENCES wxyc_schema.user(id) ON DELETE CASCADE;

ALTER TABLE wxyc_schema.schedule 
  ADD CONSTRAINT schedule_assigned_dj_id_fkey FOREIGN KEY (assigned_dj_id) REFERENCES wxyc_schema.user(id) ON DELETE SET NULL,
  ADD CONSTRAINT schedule_assigned_dj_id2_fkey FOREIGN KEY (assigned_dj_id2) REFERENCES wxyc_schema.user(id) ON DELETE SET NULL;

ALTER TABLE wxyc_schema.shift_covers 
  ADD CONSTRAINT shift_covers_cover_dj_id_fkey FOREIGN KEY (cover_dj_id) REFERENCES wxyc_schema.user(id) ON DELETE SET NULL;

ALTER TABLE wxyc_schema.shows 
  ADD CONSTRAINT shows_primary_dj_id_fkey FOREIGN KEY (primary_dj_id) REFERENCES wxyc_schema.user(id) ON DELETE SET NULL;

ALTER TABLE wxyc_schema.show_djs 
  ADD CONSTRAINT show_djs_dj_id_fkey FOREIGN KEY (dj_id) REFERENCES wxyc_schema.user(id) ON DELETE CASCADE;
