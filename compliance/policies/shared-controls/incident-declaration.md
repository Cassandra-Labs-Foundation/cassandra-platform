# SC-03 — Enterprise Incident Declaration & First-Hour Response

**Canonical source for shared control SC-03.**

## Consuming policies

| Policy | Local control preceding SC-03 | What the local control covers |
|---|---|---|
| Information Security | IS-19 | IR plan/playbook maintenance; post-mortem within 30 days of incident closure |
| E-Commerce | EC-13 | E-commerce breach detection trigger (`incident.detected` → `incident.declared`) |

## Maintenance rule

The embeddable block below must be byte-identical across all consuming policies. To update it: edit this file, then propagate the "Embeddable block" section verbatim to each policy listed above. Never edit the embedded copy in a consuming policy directly — edit this source and re-propagate.

BC-06 in the Business Continuity Plan Policy is the authoritative enterprise incident lifecycle control and the origin of this shared control's content. Any change to BC-06's declaration/first-hour mechanics must be reflected here and re-propagated to all consuming policies.

---

## Embeddable block

```
## SC-03 — Enterprise Incident Declaration & First-Hour Response {#sc-03-enterprise-incident-declaration-first-hour-response}

**WHY (Reg cite):** [12 CFR Part 748, Appendix A](https://www.ecfr.gov/current/title-12/part-748) requires a defined incident response process including declaration, containment, and communication; [FFIEC Business Continuity Management guidance](https://ithandbook.ffiec.gov/it-booklets/business-continuity-management/) requires a structured first-hour checklist and regular situation reporting. Documented declaration authority and initial actions are supervisory expectations. This control implements the enterprise incident declaration and initial-response mechanics defined in [BC-06 — Incident Declaration and Initial Actions](../business-continuity-plan/business-continuity-plan.md#bc-06-incident-declaration-and-initial-actions), which is the authoritative source for IMT roles, sitrep cadence, and incident stabilization.

**SYSTEM BEHAVIOR:** Upon declaration of a disruptive event, the IC executes a "first hour" checklist covering: (1) confirm human safety, (2) stabilize immediate threat, (3) scope the incident, (4) assign IMT roles, (5) notify required parties, and (6) set sitrep cadence. A Situation Report version 1 (Sitrep v1) must be produced within 30 minutes of declaration. Sitreps are issued every 30–60 minutes until the incident is stabilized. Declaration authority rests with the CCO, CEO, or designated IMT lead; the IC manages execution. Sitrep content and cadence are write-restricted to the IC and IMT leads.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Incident declared (`incident.declared`) | Incident scope (`incident.scope`), severity (`incident.severity`), IC identity, IMT roster | First-hour checklist initiated (`incident.first_hour.completed`), IMT roles assigned (`incident.ic.assigned`) | Immediately upon declaration |
| First-hour checklist completed (`incident.first_hour.completed`) | Safety confirmation, stabilization status, scope assessment, role assignments, notification list | Sitrep v1 issued (`sitrep.issued`), v1 timer logged (`sitrep.v1_timer`) | 30 minutes after declaration (enforced by `sitrep.v1_timer`) |
| Sitrep v1 issued (`sitrep.issued`) | Current incident status, actions taken, next steps, estimated resolution | Sitrep cadence timer set (`sitrep.cadence_timer`), subsequent sitreps issued at cadence | Every 30–60 minutes until stabilized (enforced by `sitrep.cadence_timer`) |
| Incident stabilized (`incident.contained`) | Stabilization criteria met, IC confirmation | Sitrep cadence suspended, stabilization logged (`incident.contained`) | Upon IC determination of stabilization |

**ALERTS/METRICS:** Alert fires if `incident.ic.assigned` is not logged within 15 minutes of `incident.declared`. Alert fires if Sitrep v1 is not issued within 30 minutes of declaration (`sitrep.v1_timer` breached); alert fires if sitrep cadence lapses beyond 60 minutes during active incident. Target: IC assignment ≤ 15 minutes of declaration; 100% of declared incidents with Sitrep v1 ≤ 30 minutes; zero cadence lapses during active incidents.
```
