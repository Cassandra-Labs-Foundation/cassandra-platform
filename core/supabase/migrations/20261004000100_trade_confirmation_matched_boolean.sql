-- core.trade.confirmation_matched becomes the boolean it was always declared.
--
-- The codegen-era core schema (20260702000100_core_schema.sql) created the
-- column as TEXT. The investment migration (20260719002700) declared it
-- boolean, but through `create table if not exists` / `add column if not
-- exists` — both no-ops against a table and column that already existed — so
-- the live column stayed TEXT. PostgREST then stored the handler's `true` /
-- `false` as the strings "true" / "false", and the trade.reconciliation.completed
-- evidence carried a string where IP-14 expects a verdict. Caught live by the
-- investment flow suite (core/verifier/flows/investment.test.ts).
--
-- Pre-check on the live core (2026-10-03): the column held only NULL (1080),
-- 'true' (146) and 'false' (143). The USING clause maps exactly those; any
-- other value fails the cast loudly rather than being guessed at.

alter table "core"."trade"
  alter column "confirmation_matched" type boolean
  using (
    case
      when "confirmation_matched" is null then null
      when lower(btrim("confirmation_matched")) in ('true', 't') then true
      when lower(btrim("confirmation_matched")) in ('false', 'f') then false
      else "confirmation_matched"::boolean
    end
  );
