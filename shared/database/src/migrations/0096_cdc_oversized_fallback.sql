-- Make CDC trigger visibility safe: detect oversized payloads before pg_notify
-- and emit a minimal fallback notification instead of silently dropping the event,
-- and surface any other trigger failure through a dedicated error channel.
--
-- Background: WXYC/Backend-Service#1120
-- PostgreSQL's pg_notify enforces an 8000-byte payload limit. The previous
-- cdc_notify() (migration 0046) wrapped the call in a broad `EXCEPTION WHEN
-- OTHERS ... RAISE WARNING ... RETURN NULL` block. Because cdc_notify is wired
-- as an AFTER trigger, the returned NULL is ignored by Postgres — the
-- originating INSERT/UPDATE commits, but the notification never fires. The
-- only operator signal was a PG-log WARNING line that the application servers
-- don't tail. Risk hot-spot: the enrichment worker's flowsheet UPDATE writes
-- artist_bio (free text) plus seven streaming-URL columns in a single row;
-- `to_jsonb(NEW)` can plausibly cross 8000 bytes, dropping the `liveFs:update`
-- event that dj-site SSE clients depend on.
--
-- Notification channels emitted by the updated function:
--
--   cdc            — primary channel, unchanged shape:
--                    { table, schema, action, data, timestamp }
--                    Consumers: cdc-listener.ts, cdc-websocket.ts,
--                    metadata-broadcast, enrichment-worker.
--
--   cdc_oversized  — fired in place of `cdc` when the primary payload would
--                    exceed the 7800-byte safety threshold (200 bytes of
--                    headroom below the 8000-byte pg_notify cap to cover
--                    JSON escaping in extremely rare edge cases). Carries:
--                    { table, schema, action, primary_key, payload_bytes,
--                      timestamp, reason: 'payload_too_large' }
--                    `primary_key` is best-effort: `data->>'id'` if the row
--                    has an `id` column, otherwise NULL. Consumers must
--                    refetch the row from the source of truth (e.g. REST
--                    by primary key, or a full table scan). New channel —
--                    see cdc-listener.ts subscription update.
--
--   cdc_error      — fired when the trigger body raised an unexpected
--                    exception (anything other than the oversized branch).
--                    Carries:
--                    { table, schema, action, sqlstate, sqlerrm, timestamp,
--                      reason: 'trigger_exception' }
--                    Backed by a `RAISE WARNING` so the PG log still records
--                    the failure for forensics. New channel.
--
-- Trigger contract: still AFTER INSERT/UPDATE/DELETE on the same 22+ tables
-- as 0046. AFTER triggers' return value is ignored by Postgres, but to keep
-- the function's behavior easy to reason about (and safe if a future
-- maintainer rewires it as BEFORE), we return NEW for INSERT/UPDATE and OLD
-- for DELETE.

-- @no-precondition-needed: trigger-function replacement is idempotent; no
-- data-shape invariant required.

CREATE OR REPLACE FUNCTION cdc_notify() RETURNS trigger AS $$
DECLARE
  payload jsonb;
  payload_text text;
  row_data jsonb;
  pk_value text;
  return_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
    return_row := OLD;
  ELSE
    row_data := to_jsonb(NEW);
    return_row := NEW;
  END IF;

  BEGIN
    payload := jsonb_build_object(
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'action', TG_OP,
      'data', row_data,
      'timestamp', (extract(epoch from clock_timestamp()) * 1000)::bigint
    );
    payload_text := payload::text;

    -- pg_notify hard-caps each payload at 8000 bytes. We check below 7800
    -- to leave headroom: the LISTEN-side JSON re-encode is identity, but
    -- pathological Unicode in the row could grow the wire form by a few
    -- bytes during transit.
    IF octet_length(payload_text) > 7800 THEN
      pk_value := row_data->>'id';
      PERFORM pg_notify(
        'cdc_oversized',
        jsonb_build_object(
          'table', TG_TABLE_NAME,
          'schema', TG_TABLE_SCHEMA,
          'action', TG_OP,
          'primary_key', pk_value,
          'payload_bytes', octet_length(payload_text),
          'timestamp', (extract(epoch from clock_timestamp()) * 1000)::bigint,
          'reason', 'payload_too_large'
        )::text
      );
      RAISE WARNING 'cdc_notify oversized payload: table=% action=% bytes=% pk=%',
        TG_TABLE_NAME, TG_OP, octet_length(payload_text), COALESCE(pk_value, '<none>');
    ELSE
      PERFORM pg_notify('cdc', payload_text);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Last-resort visibility path. The previous behavior silently swallowed
    -- the exception here and returned NULL. We keep returning the row (the
    -- originating mutation must not roll back on a notify failure) but emit
    -- a dedicated cdc_error notification *and* a WARNING so the failure is
    -- visible to the listener fan-out, not just the PG log.
    RAISE WARNING 'cdc_notify failed: table=% action=% sqlstate=% sqlerrm=%',
      TG_TABLE_NAME, TG_OP, SQLSTATE, SQLERRM;
    BEGIN
      PERFORM pg_notify(
        'cdc_error',
        jsonb_build_object(
          'table', TG_TABLE_NAME,
          'schema', TG_TABLE_SCHEMA,
          'action', TG_OP,
          'sqlstate', SQLSTATE,
          'sqlerrm', SQLERRM,
          'timestamp', (extract(epoch from clock_timestamp()) * 1000)::bigint,
          'reason', 'trigger_exception'
        )::text
      );
    EXCEPTION WHEN OTHERS THEN
      -- pg_notify on cdc_error itself failed (e.g. its own payload too
      -- large, which would be extraordinary given the fixed shape).
      -- Nothing else to do; the outer WARNING above is the last signal.
      NULL;
    END;
  END;

  RETURN return_row;
END;
$$ LANGUAGE plpgsql;
