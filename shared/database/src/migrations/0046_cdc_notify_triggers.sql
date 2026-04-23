-- CDC (Change Data Capture) trigger function and per-table triggers.
-- Fires pg_notify('cdc', payload) on every INSERT/UPDATE/DELETE so that
-- a LISTEN connection can stream changes to WebSocket consumers.

CREATE OR REPLACE FUNCTION cdc_notify() RETURNS trigger AS $$
DECLARE
  payload jsonb;
  row_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;

  payload := jsonb_build_object(
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'action', TG_OP,
    'data', row_data,
    'timestamp', (extract(epoch from clock_timestamp()) * 1000)::bigint
  );

  PERFORM pg_notify('cdc', payload::text);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cdc_notify failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cdc_flowsheet AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.flowsheet FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_shows AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.shows FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_show_djs AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.show_djs FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_rotation AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.rotation FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_artists AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.artists FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_genres AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.genres FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_format AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.format FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_labels AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.labels FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_library AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.library FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_compilation_track_artist AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.compilation_track_artist FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_reviews AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.reviews FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_specialty_shows AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.specialty_shows FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_schedule AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.schedule FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_dj_stats AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.dj_stats FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_shift_covers AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.shift_covers FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_cronjob_runs AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.cronjob_runs FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_bins AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.bins FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_genre_artist_xref AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.genre_artist_crossreference FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_artist_library_xref AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.artist_library_crossreference FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
CREATE TRIGGER cdc_artist_xref AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.artist_crossreference FOR EACH ROW EXECUTE FUNCTION cdc_notify();
--> statement-breakpoint
-- Public schema tables are created by better-auth at runtime, not by Drizzle
-- migrations. Use conditional creation so the migration doesn't fail in CI
-- where better-auth hasn't run yet.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_user') THEN
    CREATE TRIGGER cdc_auth_user AFTER INSERT OR UPDATE OR DELETE ON public.auth_user FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_account') THEN
    CREATE TRIGGER cdc_auth_account AFTER INSERT OR UPDATE OR DELETE ON public.auth_account FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_organization') THEN
    CREATE TRIGGER cdc_auth_organization AFTER INSERT OR UPDATE OR DELETE ON public.auth_organization FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_member') THEN
    CREATE TRIGGER cdc_auth_member AFTER INSERT OR UPDATE OR DELETE ON public.auth_member FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auth_invitation') THEN
    CREATE TRIGGER cdc_auth_invitation AFTER INSERT OR UPDATE OR DELETE ON public.auth_invitation FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_activity') THEN
    CREATE TRIGGER cdc_user_activity AFTER INSERT OR UPDATE OR DELETE ON public.user_activity FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'anonymous_devices') THEN
    CREATE TRIGGER cdc_anonymous_devices AFTER INSERT OR UPDATE OR DELETE ON public.anonymous_devices FOR EACH ROW EXECUTE FUNCTION cdc_notify();
  END IF;
END $do$;
