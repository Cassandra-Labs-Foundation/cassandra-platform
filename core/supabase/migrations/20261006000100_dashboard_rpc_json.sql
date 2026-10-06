-- Dashboard heartbeat / last-seen RPCs, returned as ONE json array.
--
-- PostgREST caps every RPC result at max_rows (1000). event_heartbeat sorts
-- oldest bucket first, so the default 7-day window silently lost its NEWEST
-- pulses (live: the last bucket returned was two days stale), and
-- event_last_seen, sorted by code, dropped the alphabetical tail — a
-- dashboard that is supposed to be a faithful audit surface, quietly
-- truncated with nothing in the payload saying so (caught by the dashboard
-- partner-flow suite). Paging would re-run each aggregate per page; a single
-- jsonb array is one query and is not subject to the row cap. The row-
-- returning functions stay as they are; these wrap them in their own order.

create or replace function "core"."event_heartbeat_json"("since" timestamptz, "bucket_seconds" integer)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb)
    from "core"."event_heartbeat"("since", "bucket_seconds") h
$$;

create or replace function "core"."gate_heartbeat_json"("since" timestamptz, "bucket_seconds" integer)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb)
    from "core"."gate_heartbeat"("since", "bucket_seconds") h
$$;

create or replace function "core"."event_last_seen_json"()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb)
    from "core"."event_last_seen"() h
$$;

create or replace function "core"."gate_last_seen_json"()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb)
    from "core"."gate_last_seen"() h
$$;

grant execute on function "core"."event_heartbeat_json"(timestamptz, integer) to service_role;
grant execute on function "core"."gate_heartbeat_json"(timestamptz, integer) to service_role;
grant execute on function "core"."event_last_seen_json"() to service_role;
grant execute on function "core"."gate_last_seen_json"() to service_role;

notify pgrst, 'reload schema';
