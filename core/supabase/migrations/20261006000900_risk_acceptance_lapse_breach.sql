-- ERM-07: the 7-day expiry escalation gets its own stamp, a lapsed
-- acceptance creates a breach RECORD, and the decision is attributed to a
-- credential (2026-10-06).
--
-- 1. `risk_acceptance.expiry_warned_at`. The 30-day alert and the 7-day
--    warning are two thresholds. The sweep used to send both at the 30-day
--    mark, so the separate escalation to the CCO 7 days before expiry never
--    happened. Each threshold now has its own fired-once stamp
--    (`expiry_alerted_at` already existed for the 30-day one).
--
-- 2. A lapsed acceptance used to emit `risk_breach.opened` and write nothing,
--    leaving no breach row to triage, present to committee or review monthly
--    (ERM-07: "the system automatically reverts the associated risk to breach
--    status by creating a `risk_breach` record"). The lapse row is linked to
--    the acceptance it came from, at most ONE per acceptance (partial unique
--    index), and carries the risk it is about.
--
-- 3. A lapse row copies the last measured excursion from the breach the
--    acceptance covered. An acceptance that covered no recorded breach has no
--    KRI reading to copy, so the measurement columns may be NULL — but ONLY on
--    a lapse row. A breach opened from an observation still has to carry its
--    reading (ck_risk_breach_measured_or_lapse), and the excursion-matches
--    check is unchanged.

alter table "core"."risk_acceptance"
  add column if not exists "expiry_warned_at" timestamptz,
  add column if not exists "requested_by" text,
  add column if not exists "decided_by_label" text;

-- Four-eyes on CREDENTIALS: the token that requested an acceptance cannot
-- decide it. `decided_by` now holds the deciding credential (ctx.tokenId);
-- the typed name moves to `decided_by_label`, a display label only.
alter table "core"."risk_acceptance" drop constraint if exists "ck_risk_acceptance_four_eyes_credential";
alter table "core"."risk_acceptance"
  add constraint "ck_risk_acceptance_four_eyes_credential"
  check ("requested_by" is null or "decided_by" is null or "decided_by" <> "requested_by");

alter table "core"."risk_breach"
  add column if not exists "risk_id" text,
  add column if not exists "risk_acceptance_id" text
    references "core"."risk_acceptance" ("id") on delete set null;

alter table "core"."risk_breach" alter column "kri_value" drop not null;
alter table "core"."risk_breach" alter column "tolerance_value" drop not null;
alter table "core"."risk_breach" alter column "current_excursion" drop not null;

alter table "core"."risk_breach" drop constraint if exists "ck_risk_breach_measured_or_lapse";
alter table "core"."risk_breach"
  add constraint "ck_risk_breach_measured_or_lapse"
  check (
    "risk_acceptance_id" is not null
    or ("kri_value" is not null and "tolerance_value" is not null and "current_excursion" is not null)
  );

create unique index if not exists "ux_risk_breach_lapsed_acceptance"
  on "core"."risk_breach" ("risk_acceptance_id") where "risk_acceptance_id" is not null;

-- sim mirrors core (created `like ... including all`)
alter table "sim"."risk_acceptance"
  add column if not exists "expiry_warned_at" timestamptz,
  add column if not exists "requested_by" text,
  add column if not exists "decided_by_label" text;

alter table "sim"."risk_acceptance" drop constraint if exists "ck_risk_acceptance_four_eyes_credential";
alter table "sim"."risk_acceptance"
  add constraint "ck_risk_acceptance_four_eyes_credential"
  check ("requested_by" is null or "decided_by" is null or "decided_by" <> "requested_by");

alter table "sim"."risk_breach"
  add column if not exists "risk_id" text,
  add column if not exists "risk_acceptance_id" text;

alter table "sim"."risk_breach" alter column "kri_value" drop not null;
alter table "sim"."risk_breach" alter column "tolerance_value" drop not null;
alter table "sim"."risk_breach" alter column "current_excursion" drop not null;

alter table "sim"."risk_breach" drop constraint if exists "ck_risk_breach_measured_or_lapse";
alter table "sim"."risk_breach"
  add constraint "ck_risk_breach_measured_or_lapse"
  check (
    "risk_acceptance_id" is not null
    or ("kri_value" is not null and "tolerance_value" is not null and "current_excursion" is not null)
  );

create unique index if not exists "ux_sim_risk_breach_lapsed_acceptance"
  on "sim"."risk_breach" ("risk_acceptance_id") where "risk_acceptance_id" is not null;
