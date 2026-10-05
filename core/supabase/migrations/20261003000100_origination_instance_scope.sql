-- Resolving an origination is scoped to the instance that owns it (D23).
--
-- accept_origination / reject_origination looked the origination up by id
-- alone, and the aggregator handler passed only the id from the path. Any
-- instance holding a valid token could therefore accept or reject ANOTHER
-- fintech's origination — capture or release its reserve — knowing only the
-- id. Caught live by the partner-flow suite (core/verifier/flows/
-- origination.test.ts), which resolved a foreign program's origination with
-- inst_local's token and got 200.
--
-- Both functions now take the caller's instance (from the verified JWT
-- claims) and match on it. Another instance's origination is reported as
-- not_found, the same answer as a nonexistent id, so existence does not leak.
-- The one-argument versions are dropped so the unscoped form cannot be
-- called by anything.

drop function if exists "aggregator".accept_origination(text);
drop function if exists "aggregator".reject_origination(text);

create or replace function "aggregator".accept_origination(p_id text, p_instance text)
returns jsonb language plpgsql as $$
declare
  org record;
  pos_before bigint;
  pos_after bigint;
begin
  select o.id, o.instance_id, o.amount_cents, o.status into org
    from "aggregator"."origination" o
    where o.id = p_id and o.instance_id = p_instance for update;
  if org.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if org.status <> 'pending' then
    return jsonb_build_object('error', 'wrong_state', 'status', org.status);
  end if;

  pos_before := "aggregator".member_share_cents(org.instance_id);

  update "aggregator"."reserve" set status = 'captured', updated_at = now()
    where origination_id = p_id and status = 'held';
  if not found then return jsonb_build_object('error', 'reserve_missing'); end if;

  update "aggregator"."origination" set status = 'accepted', updated_at = now()
    where id = p_id;

  pos_after := "aggregator".member_share_cents(org.instance_id);

  return jsonb_build_object('origination_id', p_id, 'status', 'accepted',
    'position_before_cents', pos_before, 'position_after_cents', pos_after);
end $$;

create or replace function "aggregator".reject_origination(p_id text, p_instance text)
returns jsonb language plpgsql as $$
declare
  org record;
begin
  select o.id, o.instance_id, o.amount_cents, o.status into org
    from "aggregator"."origination" o
    where o.id = p_id and o.instance_id = p_instance for update;
  if org.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if org.status <> 'pending' then
    return jsonb_build_object('error', 'wrong_state', 'status', org.status);
  end if;

  update "aggregator"."reserve" set status = 'released', updated_at = now()
    where origination_id = p_id and status = 'held';
  update "aggregator"."origination" set status = 'rejected', updated_at = now()
    where id = p_id;

  return jsonb_build_object('origination_id', p_id, 'status', 'rejected');
end $$;

notify pgrst, 'reload schema';
