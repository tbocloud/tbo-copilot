# Phase 4: The pilot with the first customer, and hardening

**Status:** plan written 13 Oct 2026; **approved by the owner 17 Oct 2026 with every recommended decision** (the pilot customer only; Copilot level per customer; the stage gates; $100 a month with $1/$3 per run; the pull request series; the weekly email; customization_request; the Vue card later). Since TASK-2026-00012 the model map is Luna first, Kimi as the fallback. H15 and W7 are built now; G waits for TBO. **Estimate:** about 8 developer-days of building, then the pilot itself (about 8 weeks): H15 (pilot controls and measurement, ≈ 3), W7 (hardening of the worker and its server, ≈ 3), G (going live on the real hub and the pilot customer's site, ≈ 2, with TBO). **Design reference:** `../system-design.md` §7 (Phase 4), §8 (verification: red team, evaluation), §9 (risks); `../build-plan.md` Phase 4; the pilot rules (a person presses Deploy; settings and data only with a senior; automatic deploys only after clean ones). **Built on:** Phases 0 to 3 (helpdesk `tbo-copilot`, helpdesk_client `tbo-copilot`, the worker in a pull request).

## Goal

Copilot works on **the pilot customer's real tickets** on the live TBO Support, in four stages, each started only when the one before met its numbers:

1. **Diagnose only (shadow):** Copilot investigates every ticket; the team sees the diagnosis and rates it; the customer sees nothing.
2. **Explain:** the customer sees the stages; Copilot's explanations and questions go out when an agent sends them; bugs go to the developer as today, with the one approval and Deploy.
3. **Fix:** Copilot writes fixes when an agent asks; one approval; Deploy through Press in the night window.
4. **Correct:** settings and data corrections, approved by a senior.

Every week the owner gets numbers: how often Copilot is right, what it costs, how long approvals wait, what went wrong. At the end, a decision: more customers, and which automatic steps (if any) to switch on.

## What exists today, and what it means for this phase

| Found (13 Oct) | Consequence |
|---|---|
| Everything runs on the local pair (tbo.localhost ↔ customer.localhost). The live TBO Support (on AWS) runs helpdesk without the Copilot branches; the pilot customer's live site runs the connector without the write guard | Going live is its own step (G): the branches reviewed and merged, the live hub and the pilot customer's site updated, settings made |
| The checkpoints of 1c-2 (server, GitHub App), 1d (the approval demo), 2 (Press login and test site) and 3 (the corrections demo) are still open | The stages open in order as they pass: stage 1 needs only the hub, the connector and a worker; stage 3 needs 1c-2 and 2; stage 4 needs 3 |
| Shadow mode is one switch for all customers | A pilot that moves one customer through stages (and starts the next in shadow) needs a **Copilot level per customer** |
| Each run records its tokens and cost; there is no monthly limit | A **monthly AI budget** for the pilot, with an alert before it is reached |
| Agents can rate a diagnosis (Right, Partly, Wrong); approvals, deploys and corrections are all recorded | The weekly numbers can be computed from what is already stored: a report and a weekly email |
| Nothing watches the worker: if its server stops, runs wait silently | A **worker watch**: the Agent Managers are told when runs wait and no worker claims them |
| The red team of the design (§8) has not been run | It runs before stage 1, on the local pair |
| A feature request has no root-cause category; the worker answers it as a question and says "customization" in its proposal | Optional: a `customization_request` category, so the numbers show them apart and an agent can start the estimate (decision 7) |

## Decisions in this plan (please confirm)

| # | Topic | This plan | Why |
|---|---|---|---|
| 1 | Who | **The pilot customer only** for the first 8 weeks; a second customer starts in stage 1 after week 4 if stage 2 goes well | One customer whose apps and site we know; the second starts safely in shadow |
| 2 | Control | A **Copilot level per customer** (HD Customer): Diagnose only, Explain, Fix, Correct. It replaces the single shadow switch for the pilot (the switch stays as a master "shadow for everyone") | Each customer moves through the stages on its own; nothing above its level can happen |
| 3 | Stages and gates | Stage 1, 2 weeks: at least 15 diagnoses rated, at least 70% Right (Partly counts half), no safety incident → stage 2. Stage 2, 2 weeks: explanations sent with few edits, approvals answered within a working day → stage 3. Stage 3: at least 3 Copilot fixes merged and deployed with no undo → stage 4. Stage 4 runs to week 8 | Numbers, not impressions, open each stage |
| 4 | Money | A **monthly AI budget** of $100 for the pilot (a setting). At 80% the Agent Managers are told; at 100% new runs wait until the next month or a raised budget. Per run: $1 for a diagnosis, $3 for a fix | The evaluation cost about $0.19 a diagnosis; $100 leaves room for fixes and mistakes |
| 5 | Going live | The `tbo-copilot` branches go into `main` as a **pull request series** (one per phase, already tested), reviewed by the helpdesk maintainer, then the live hub is updated in the night window. The pilot customer's site gets the connector through Press | The live hub is the team's daily tool; the helpdesk maintainer owns both apps |
| 6 | What the owner sees | A **weekly email** (Monday morning) to the owner and the Agent Managers, and a report in TBO Support with the same numbers | The pilot is decided on numbers |
| 7 | Feature requests | Add a **customization_request** category: Copilot says it is a customization, the draft offers an estimate, and the agent starts the existing estimate flow | Separates "not a defect" from questions in the numbers, and gets the customer a quote faster |
| 8 | The Vue card on the ticket page | **Later**: the dialog stays for the pilot | It works; a new card is polish, not safety |

## What you will see at the end

- Weeks 1–2: every ticket of the pilot customer gets a diagnosis note within minutes; agents rate them; the first weekly email shows the rate, the cost and the time.
- Weeks 3–4: the pilot customer sees "Working on it", "Fix scheduled", "Resolved" on its own tickets; explanations go out after an agent's read; bugs are approved on the ticket and deployed through Press at night.
- Weeks 5–6: on chosen bugs, Copilot writes the fix on a cleaned copy of the pilot customer's site; the developer approves it; it is deployed and checked.
- Weeks 7–8: a wrong setting or wrong data is corrected after a senior's approval and shows in the pilot customer's change log.
- Week 8: the pilot report: rates, costs, waits, incidents, and a recommendation (more customers; automatic deploys for proven categories; what to improve).

## What changes, part by part

### G (with TBO): going live (≈ 2 days of mine, plus TBO's review and deploy)

| Item | Detail |
|---|---|
| The pull request series | helpdesk: one pull request per phase from `tbo-copilot` into `main` (0, 1a, 1b, 1c, 1d, 2, 3, 4), each with its tests and `Closes TASK-…`; helpdesk_client the same; the worker's a pull request into `tbo`. Before each: `main` merged in and the modules re-run |
| The live hub | Updated in the night window after a backup; migrate; **Copilot enabled, shadow for everyone, every customer at level Diagnose only** until set; the worker user (Copilot Worker role, API keys) created; approvers and seniors set |
| The pilot customer's site | The connector updated through Press; reconnected once with a connection code (its approval key); the write list **empty** until stage 4; the site card filled (Refresh from the site, and from Press) |
| The worker | On the AWS server (1c-2's W0), pointed at the live hub; the evaluation set run once against the live hub's data model before stage 1 |
| Switching off | **Copilot enabled** off stops everything at once (no new runs, no claims); runs in flight finish as Escalated. Tested before going live |

### H15 (helpdesk): pilot controls and measurement (≈ 3 days)

| Item | Detail |
|---|---|
| Copilot level per customer | HD Customer **Copilot level**: Diagnose only, Explain, Fix, Correct (default Diagnose only). The router, fix requests, change sets and approvals respect it: below Explain a run is a shadow run; below Fix, "Let Copilot fix it" is not offered and Copilot writes no code; below Correct, a change set is shown but never approved. The global shadow switch still forces everyone to Diagnose only |
| Monthly AI budget | HDS Copilot Settings **Monthly AI budget (USD)** and **per-run caps** (diagnosis, fix), sent to the worker with each claim. `claim_job` hands out no work once the month's spend reaches the budget; at 80% the Agent Managers are told once |
| The pilot report | A report **Copilot Pilot** (per week and per customer): tickets, diagnoses and their ratings, root causes, explanations sent and how much agents edited them, fixes (asked, opened, approved, merged, deployed, undone), corrections (applied, skipped, undone), median approval wait, median time to resolution, AI cost per ticket, escalations and refusals, the Wrong diagnoses to look at |
| The weekly email | Monday 08:00 (Asia/Riyadh): the week's numbers and the links, to the owner and the Agent Managers |
| Worker watch | Every 10 minutes: runs waiting more than 15 minutes with no worker claiming → the Agent Managers are told once an hour while it lasts |
| customization_request | The ninth category: Explaining, the draft offers an estimate, the card offers "Start estimate" (the existing estimate flow) |
| Tests | Levels at each step, the budget stop and alert, the report's numbers on known runs, the watch, the new category |

### W7 (worker and server): hardening (≈ 3 days)

| Item | Detail |
|---|---|
| Red team | On the local pair, before stage 1: instructions planted in a ticket, an error log, a repository's `AGENTS.md` and a recording transcript; a planted `.env` and links out of the app. Expected: refusals, no internet from sandboxes, no secrets in events, pull requests or reports, and "suspicious instruction" noted in the evidence. A short report |
| Limits and load | The per-run caps from the hub; two investigations at once and one fix, on the pilot server, measured (memory, time, cost); the queue of 10 runs drained in order |
| The model map | Kimi first, OpenAI when Kimi fails or runs out; the evaluation set re-run after any change of model or prompt, its results kept |
| Server care | CloudWatch alarms (CPU, disk, the server down) to the Agent Managers; a weekly snapshot of the system disk; log rotation |
| Runbooks | `docs/tbo/worker-server.md` (start, stop, update, keys, logs) and incident runbooks: the AI provider down or out of credit; the queue stuck; a wrong fix merged (Undo the fix); a correction gone wrong (Undo the change); a deploy that failed (Phase 2's runbook) |

## Out of scope (later)

- The Vue card and a `/copilot` board.
- The Teams bot with buttons, and Microsoft sign-in.
- Automatic deploys: the setting from Phase 2 stays empty; the pilot report recommends categories after at least 10 clean deploys.
- More than two customers.
- Copilot writing fixes for repositories in organisations without the GitHub App.
- Press UAT for customer acceptance; proactive error watch; known-issue memory.

## How it is built, run and tested

- H15 and W7 are built on the Mac and the local pair like the earlier phases (module tests with `hold_commits`, leftovers checked), then join the pull request series.
- The red team and the load test run on the local pair and the pilot server before stage 1.
- The pilot runs on the live hub; every stage change is the owner's decision on the weekly numbers.
- A weekly 30-minute review with the owner: the numbers, the Wrong diagnoses, the prompts or the model map to adjust.

## Checkpoint (end of the pilot)

1. The four stages reached, each gate met in numbers.
2. No safety incident: no write outside an approval, no secret in any event, report or pull request, no customer message sent by itself.
3. The pilot report: rating rate, cost per ticket, approval wait, fixes and corrections with their outcomes.
4. The decision: a second (and third) customer, automatic deploys for proven categories or not, and what to build next.

## Risks

- **A large change to the live hub.** Many pull requests reach the team's daily tool. Mitigation: one phase per pull request, each tested; the night window; a backup first; **Copilot enabled** off as the instant stop; the update itself can be reverted.
- **Real customer data with an AI provider.** Mitigation: the providers' data terms recorded, the pilot customer's agreement before stage 1, only cleaned copies on the server, small samples in prompts.
- **Copilot is wrong in front of a customer.** Mitigation: two weeks of shadow first; every explanation is sent by an agent; Reopen always goes to a person.
- **Cost.** Mitigation: the monthly budget and per-run caps; the weekly email shows the spend.
- **Approvers become the bottleneck.** Mitigation: reminders and escalation exist; the wait is measured weekly; the rota is adjusted.
- **The worker server stops.** Mitigation: the worker watch; leases put runs back in the queue; the runbook.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| The earlier phases' items: the Moonshot top-up and data terms, an OpenAI key, the AWS server, the GitHub App on tbocloud and teambackoffice, a Copilot Press login and test site | all stages | before stage 1 (server, keys); before stage 3 (App, Press) |
| The 1d, 2 and 3 demos passed on the local pair (your Approve on ticket 0101; the Press test; your OK for the corrections demo) | going live | before G |
| the helpdesk maintainer's review and merge of the pull request series, and a night window for the live hub's update | G | before stage 1 |
| The pilot customer's agreement: Copilot reads their tickets and site, cleaned copies of their database on TBO's server, corrections only after a senior's approval | stage 1; stage 4 | before stage 1 |
| The pilot people: who rates diagnoses (stage 1), the approvers and seniors, the pilot customer's assigned developer | stages 1 to 4 | before stage 1 |
| The monthly AI budget (suggested $100) and who receives the weekly email | H15 | any time |
| The pilot customer's write list for stage 4 (which doctypes Copilot may correct) | stage 4 | before stage 4 |

## As built (17–18 Oct 2026)

**H15, helpdesk `tbo-copilot` (pushed):**
- HD Customer **Copilot Level** (Diagnose only, Explain, Fix, Correct); blank uses HDS Copilot Settings → Pilot →
  **Default Copilot level**. Gates: a run's shadow flag (below Explain), Copilot writing a fix (below Fix: refused,
  the button hidden), corrections (below Correct: checked and shown, event `change_set_held`, never sent for
  approval, approved or applied, even when the level is lowered later). Shadow mode holds everyone at Diagnose
  only. Patch `copilot_pilot_defaults`: default level Correct where shadow mode was off (demo hub keeps working),
  Diagnose only elsewhere; budget $100, diagnosis cap $1.
- **Copilot enabled off = instant stop** (built here, planned for G): no claims; a run in flight is cancelled at its
  next heartbeat (a fix job marked Failed).
- **Monthly AI budget**: usage rows with a Copilot run this month; 80% and 100% alerts once a month to the Agent
  Managers; at 100% `claim_job` gives nothing. Diagnosis cap sent as `run_context.limits.max_usd`.
- **Worker watch** every 10 minutes (runs or fix jobs waiting 15 minutes, hourly alert).
- **Copilot Pilot** report (per week and customer) and the Monday 08:00 Riyadh email (hourly check, once a week,
  `pilot_report_to` + the Agent Managers). Explanation edits measured on the run (`explanation_edited`).
- **customization_request**: Explaining with an estimate offer; "Start estimate" makes the ticket a Customization
  with Copilot's hours; stage "With our team" after the reply.
- **Planted instructions** (red-team finding): `suspicious.py` on the ticket and the customer's messages, the worker
  on its tool results; `suspicious_instruction` events; a warning box in the Copilot dialog.
- Tests: `test_copilot_pilot.py` 19, `test_copilot_changes.py` +2 (25); 25 Copilot modules pass. The one failing
  deploy test (`test_it_is_no_other_customer_and_never_moves`) fails the same on the commit before Phase 4 between
  21:05 and midnight Riyadh time: a time-of-day flake in the Phase 2 tests, to fix separately.

**W7, a pull request**: the diagnosis cap, customization_request in the worker's rules and
report tool, the `suspicious_instruction` scan of tool results, the red-team end-to-end test, and
`docs/tbo/worker-server.md` (runbooks). Red team: the private evaluation notes (no instruction followed, no
leak, every root cause right).

**Monitoring:** TBO uses Grafana Cloud, not CloudWatch: a local commit in TBO's private infrastructure repository (Alloy container with
host metrics on the worker server, the host in "Host not reporting"; operator action 30). Not pushed: needs the
owner's OK, then the operator's token and commands.

**Still open in Phase 4:** the load test on the pilot server (two investigations and a fix at once, ten runs
drained in order); the fix stage's red team on the fix server; G (the pull request series, the live hub,
the pilot customer's site) with TBO.
