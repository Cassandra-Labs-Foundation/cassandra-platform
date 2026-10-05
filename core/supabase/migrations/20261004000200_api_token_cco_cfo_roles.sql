-- CCO and CFO duty roles become issuable; capital-target four eyes binds to
-- credentials; a PIR must name a declared incident.
--
-- 1. api_token.roles. auth.ts added `cco` (CP-03: capital targets are
--    write-restricted to the CCO) and `cfo` (CP-05/CP-06: the capital plan and
--    stress report are write-restricted to the CFO), but ck_api_token_roles
--    (20260719001000_bsa_roles_and_four_eyes.sql) still allowed only the four
--    BSA roles, so no token could carry either and both gates could only be
--    satisfied by a fallback role. The vocabulary below is exactly the set of
--    roles the handlers check (auth.ts BsaRole): still closed, still empty by
--    default, so no existing token widens.
alter table "core"."api_token" drop constraint if exists "ck_api_token_roles";
alter table "core"."api_token"
  add constraint "ck_api_token_roles"
  check ("roles" <@ array[
    'bsa_investigator',  -- BSA-06: opens and closes cases
    'bsa_officer',       -- BSA-06/07: writes the SAR decision
    'bsa_compliance',    -- BSA-07: sits on the SAR committee; SC-01
    'bsa_counsel',       -- BSA-07: legal counsel, "as needed"; SC-01
    'cco',               -- CP-03: sets internal capital targets
    'cfo'                -- CP-05/CP-06: files the capital plan and stress report
  ]::text[]);

comment on column "core"."api_token"."roles" is
  'Duty roles (OQ-08, CP-03, CP-05/06). Deliberately NOT a general permission system: a closed six-value vocabulary (four BSA roles plus cco and cfo) gating specific write endpoints. Empty by default so the column cannot widen an existing token.';

-- 2. capital_target four eyes on CREDENTIALS. ck_capital_target_four_eyes
--    compares the proposed_by / approved_by NAMES, which come from the request
--    body: one token could file a target with an approver it invented. These
--    columns record the api_token.id that proposed and the one that approved
--    (the approver is always the caller), and the check makes them differ.
--    Existing rows predate the binding and stay NULL, which the check allows.
--    sim gets the columns only, matching how its mirror tables were created.
alter table "core"."capital_target" add column if not exists "proposed_by_token" text;
alter table "core"."capital_target" add column if not exists "approved_by_token" text;
alter table "sim"."capital_target" add column if not exists "proposed_by_token" text;
alter table "sim"."capital_target" add column if not exists "approved_by_token" text;

alter table "core"."capital_target" drop constraint if exists "ck_capital_target_four_eyes_token";
alter table "core"."capital_target"
  add constraint "ck_capital_target_four_eyes_token"
  check ("approved_by_token" is null or "approved_by_token" is distinct from "proposed_by_token");

comment on column "core"."capital_target"."proposed_by_token" is
  'api_token.id that proposed this target (CP-03 four eyes). NULL only on rows written before the binding.';
comment on column "core"."capital_target"."approved_by_token" is
  'api_token.id that approved this target: always the approving caller, never a body field. Must differ from proposed_by_token.';

-- 3. pir.incident_id had no foreign key, so a post-incident review of an
--    incident nobody declared could be stored. Checked before writing this:
--    no existing core.pir or sim.pir row references a missing incident.
--    No cascade — deleting an incident must not silently delete its review.
--    core only: sim.incident was created without a primary key (LIKE without
--    INCLUDING CONSTRAINTS), so it cannot be referenced; sim mirrors carry
--    columns, not constraints, throughout this schema.
alter table "core"."pir" drop constraint if exists "fk_pir_incident";
alter table "core"."pir"
  add constraint "fk_pir_incident"
  foreign key ("incident_id") references "core"."incident" ("id");

notify pgrst, 'reload schema';
