-- EPS-07 defect fix (2026-10-06): card-control history.
--
-- Rows were keyed epscc_<card>_<type>_<value> and upserted, and "the prior
-- value" was read as the newest row by created_at. An upsert never advances
-- created_at, so toggling on, off, on, OFF read the old 'off' row as the
-- latest state: the fourth toggle reported previous_value 'off' and emitted no
-- change event, and every repeated value overwrote its earlier application.
--
-- control_seq is a per-(card_ref, control_type) monotonic sequence, the same
-- shape as eps_auth_event.chain_seq (20260811000200): every application takes
-- prior control_seq + 1 and is inserted as its own row, so "the latest
-- application" is a deterministic read in the real database and the drill
-- fake alike (created_at is not: frozen drill clock, same-ms bursts).

alter table "core"."eps_card_control"
  add column if not exists "control_seq" int not null default 0;

-- Backfill: order surviving rows by when they were last written. The
-- historical record is already lossy (overwritten applications are gone);
-- this only gives the survivors a stable order to continue from.
update "core"."eps_card_control" c set "control_seq" = s.rn
from (
  select "id", row_number() over (
    partition by "card_ref", "control_type" order by "created_at", "id"
  ) as rn
  from "core"."eps_card_control"
) s
where c."id" = s."id" and c."control_seq" = 0;

create index if not exists "idx_eps_card_control_seq"
  on "core"."eps_card_control" ("card_ref", "control_type", "control_seq" desc);

comment on column "core"."eps_card_control"."control_seq" is
  'Per-(card_ref, control_type) monotonic application sequence. The latest application is max(control_seq) — never order card-control state by created_at (EPS-07 previous-value defect, fixed 2026-10-06).';

-- The sim mirrors were created LIKE core before either sequence column existed.
alter table "sim"."eps_card_control"
  add column if not exists "control_seq" int not null default 0;
alter table "sim"."eps_auth_event"
  add column if not exists "chain_seq" int not null default 0;

notify pgrst, 'reload schema';
