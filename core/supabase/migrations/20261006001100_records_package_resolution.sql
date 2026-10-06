-- RS-08: let the resolution records package actually be stored.
--
-- core.records_package is shared by two writers: the cash-ops exam exports
-- (20260719002400, which made purpose/scope/requested_at NOT NULL and limited
-- purpose to exam_export/supervisory_count/internal) and the RS-08 resolution
-- package (20260719003700). The resolution writer never set purpose, so every
-- RS-08 insert failed — silently, because the error was ignored. The writer
-- now sets purpose 'resolution'; this widens the vocabulary to admit it.
--
-- 20260719003700 declared its integrity constraints inside a CREATE TABLE IF
-- NOT EXISTS that was a no-op (the table already existed), so none of them
-- exist on a migrated database. Add them here. ck_package_completion_chained
-- is scoped to resolution packages: an exam export completes without a
-- checksum chain by design.

do $$
declare s text;
begin
  foreach s in array array['core', 'sim'] loop
    if to_regclass(format('%I.records_package', s)) is null then
      continue;
    end if;

    execute format('alter table %I.records_package drop constraint if exists records_package_purpose_check', s);
    execute format($f$alter table %I.records_package add constraint records_package_purpose_check
      check (purpose in ('exam_export', 'supervisory_count', 'internal', 'resolution'))$f$, s);

    -- sim.records_package was copied before the RS-08 columns existed
    if not exists (select 1 from information_schema.columns
                   where table_schema = s and table_name = 'records_package'
                     and column_name = 'verification_failed_at') then
      continue;
    end if;

    -- COMPLETED AND FAILED ARE MUTUALLY EXCLUSIVE
    if not exists (select 1 from pg_constraint
                   where conname = 'ck_package_not_both'
                     and conrelid = format('%I.records_package', s)::regclass) then
      execute format($f$alter table %I.records_package add constraint ck_package_not_both
        check (completed_at is null or verification_failed_at is null)$f$, s);
    end if;

    -- a failure has to say what failed
    if not exists (select 1 from pg_constraint
                   where conname = 'ck_package_failure_reasoned'
                     and conrelid = format('%I.records_package', s)::regclass) then
      execute format($f$alter table %I.records_package add constraint ck_package_failure_reasoned
        check (verification_failed_at is null or records_package_failure_reason is not null)$f$, s);
    end if;

    -- a resolution package cannot be complete without the chain that proves it
    if not exists (select 1 from pg_constraint
                   where conname = 'ck_package_completion_chained'
                     and conrelid = format('%I.records_package', s)::regclass) then
      execute format($f$alter table %I.records_package add constraint ck_package_completion_chained
        check (purpose <> 'resolution' or completed_at is null
               or records_package_checksum_chain is not null)$f$, s);
    end if;
  end loop;
end $$;
