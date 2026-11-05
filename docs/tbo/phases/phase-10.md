# Phase 10: the Copilot board

Status: plan written 28 Oct 2026; **approved 28 Oct 2026 (all five decisions as recommended)**; **built 28 Oct 2026** (see As built); the checkpoint on the demo hub is next.

Owner (28 Oct 2026): "do next phase" after Phase 9. Of the "Later" list, the `/copilot` board is the one that can be
built without outside help. Microsoft sign-in needs TBO's Microsoft 365 admin, and Press UAT needs a UAT site per
customer, so both stay later.

## Goal

One page in TBO Support where a team lead sees all of Copilot's work at a glance, every morning:

- what Copilot is doing and where each ticket stands;
- what waits for a person (approvals, explanations to send, tickets handed over);
- releases and deploys;
- the customer sites (code drift, the error watch);
- known issues;
- whether the worker is alive and how much of the monthly AI budget is spent.

Today all of this is spread over ticket dialogs, Teams cards, list views and the weekly report.

## What exists today, and what it means for this phase

- **The data is all on the hub:**
  - runs and their states (HDS Copilot Run);
  - approvals of fixes and corrections (HDS Copilot Approval, HDS Copilot Change Set);
  - releases and deploys (HDS Deploy Request);
  - site cards with drift and the error watch (HDS Site Registry);
  - known issues (HDS Known Issue);
  - the month's AI spend (`pilot.month_spend`) and runs no worker picked up (`pilot.waiting_runs`).

  The board is a new view, not new data.
- **Missing:** when the worker last asked for work. `claim_job` is called every 15 seconds but leaves no trace once
  nothing is queued.
- **The agent app** (Vue, `desk/src`) already has pages like Stand-up and Team dashboard, and the **TBO Copilot**
  sidebar item opens the Phase 6 chat panel. The ticket's Copilot dialog (a form script) and the Teams cards stay
  where people decide things.

## Decisions (approved 28 Oct 2026, all as recommended)

1. **Look, don't decide, on the board.** *(Recommended.)* Every item links to where it is decided today: the
   ticket's Copilot dialog, the release card, the Teams card. One approval path keeps the senior rule, "first decision
   wins" and the audit trail in one place. Alternative: Approve and Reject buttons on the board too.
2. **Who sees it.** *(Recommended: every agent, each sees what their permissions allow.)* Lists are read with the
   agent's own permissions, so team restrictions on tickets apply. Agent Managers see everything, including the
   budget and the worker. Alternative: Agent Managers only.
3. **Where it lives.** *(Recommended.)* `/helpdesk/copilot`, opened from the **TBO Copilot** sidebar item, which
   gets two entries: **Board** and **Chat** (the Phase 6 panel). It works on a phone too.
4. **Freshness.** *(Recommended.)* It refreshes when a run changes (the existing `helpdesk:copilot-run` realtime
   event) and every minute otherwise. No email or Teams digest is added; the 09:00 digest and the Monday email stay.
5. **The ticket page's Vue card** (also on the Later list) stays out of this phase. *(Recommended.)* The form-script
   dialog works, and replacing it touches the ticket page that the helpdesk team changes daily.

## What you will see at the end

**The top strip:**
- the worker: online or not, and when it last asked for work;
- runs waiting for a worker;
- the month's AI spend against the budget;
- shadow mode on or off.

**Five tabs:**
1. **Work**, Copilot's runs in columns:
   - **Investigating** (queued or working);
   - **With the customer** (an explanation to send, or waiting for their answer);
   - **Fixing** (Copilot's fix queued, working, or failed);
   - **Waiting for approval**;
   - **Shipping** (approved, merging, merged, deploying, checking);
   - **Needs a person** (escalated, handed over, failed);
   - a count of tickets resolved this week.

   Each card shows the ticket, customer, subject, root cause, how long it has waited, and who it waits on. Filters:
   customer, "only mine", "raised by the error watch".
2. **Approvals.** One list of every fix, correction and release waiting for a person. Each row shows who it is
   assigned to, how long it has waited, the escalation time, risk, whether it is sensitive, and whether it is
   snoozed. Each links to where it is decided.
3. **Releases.** The pipeline: waiting for CI, the sandbox check, waiting for approval, tonight's train, deploying
   and checking, plus the last 7 days' results. Each release shows its commits and sites.
4. **Sites.** Each customer site:
   - its Copilot level;
   - each app's commit and drift;
   - when the site card was last read;
   - the error watch (watched or not, last check, failures, note);
   - open known issues, and known fixes it does not have yet.
5. **Known issues.** Open, fixed and came-back issues, with the sites that still lack a fix.

## What changes, part by part

### H31 (helpdesk): the board's API (≈ 2 days)

- `helpdesk/api/copilot_board.py`, read-only and agents only. Lists go through `frappe.get_list` (the person's
  permissions); the budget and worker parts are for Agent Managers.
  - `summary`: the top strip.
  - `work(customer, mine, source)`: runs by column, at most 50 per column with "and N more".
  - `approvals`: fixes, corrections and releases waiting.
  - `releases(days)`
  - `sites(customer)`
  - `known_issues(status)`
- `claim_job` records the worker's last request in the cache (`copilot:worker-seen:<id>`, kept a day).
  `summary` reads it.
- Tests: `test_copilot_board.py` covers the columns, permissions (an agent without access to a ticket does not see
  its run), the manager-only parts, filters, and the counts and "more".

### H32 (helpdesk): the page (≈ 3 days)

- `desk/src/pages/copilot/CopilotBoard.vue` with five tab components, in the style of the Stand-up and Team
  dashboard pages: frappe-ui, light and dark, phone width.
- Route `/copilot` and the sidebar's **TBO Copilot** item with Board and Chat (desktop and mobile).
- Realtime refresh on `helpdesk:copilot-run`, plus every minute.
- Every link opens the ticket, its Copilot dialog, the release or the site card.

### H33: docs and the checkpoint (≈ 1 day)

- `docs/tbo-copilot.md` gets a Copilot board section.
- A walk-through on the demo hub with real data: the Phase 6–9 tickets, releases and sites.

## Out of scope (later)

- Deciding on the board (decision 1).
- The ticket page's Vue card (decision 5).
- Charts over time. The Copilot Pilot report and the Monday email stay the place for numbers.
- Microsoft sign-in and Press UAT (owner's order).

## How it is built, run and tested

- Built and tested on the Mac: module tests with `hold_commits` on tbo.localhost, `yarn build` of the desk, and a look
  at the page on the local site in light, dark and phone width.
- Pushed to helpdesk `tbo-copilot` under the standing instruction. No worker or customer-site change.

## Checkpoint (on the demo hub)

1. The top strip shows the worker online and the month's spend. Stopping the worker turns it to "not seen for N
   minutes" within a minute.
2. Work shows the demo tickets in the right columns. A run moving (for example a fix approved in Teams) moves its
   card without a reload.
3. Approvals lists the waiting fix or release with its assignee and wait, and the link opens where it is decided.
4. Releases shows TBO-DEP-2026-##### as Succeeded, and the next merge appears as Waiting for CI.
5. Sites shows demo-alpha and demo-beta with their commits and the error watch's last check. Known issues shows the
   Phase 9 checkpoint's issue.
6. An agent restricted to one team sees only that team's tickets. A non-manager sees no budget or worker details.

## Risks

- **A slow page.** Mitigation: counts and at most 50 cards per column, indexed filters, one call per tab.
- **Showing a ticket to someone who may not read it.** Mitigation: everything through the person's permissions,
  tested.
- **Two places to decide.** Mitigation: the board only links (decision 1).
- **Conflicts with the helpdesk maintainer's daily work in `desk/`.** Mitigation: a new page folder, plus one route and one sidebar
  entry.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| The approval of this plan and its 5 decisions | everything | now |
| A demo hub redeploy after it is built | the checkpoint | after the build |

Estimate: about **6 days** (H31 2, H32 3, H33 1).

## As built (28 Oct 2026)

**Helpdesk `tbo-copilot` (pushed):**
- **H31.**
  - `copilot/board.py` holds the logic and `api/copilot_board.py` the agent-only, read-only endpoints: `summary`, `work`, `approvals`, `releases`, `sites`, `known_issues`.
  - `visible_tickets` filters through HD Ticket's own permission rules (team restrictions included).
  - The worker and the AI budget are for Agent Managers.
  - `claim_job` calls `board.worker_seen`, a cache hash `copilot:workers-seen`. A worker is online when it asked within 2 minutes.
  - `runs.publish_run` also sends `helpdesk:copilot-board` with an empty payload.
  - Tests: `test_copilot_board.py` (11): columns, the latest run only, 30 days for problems, the mine and error-watch filters, team restriction, manager-only parts, agents only, the realtime signal without names, approvals and releases, sites and known issues.
- **H32.**
  - `desk/src/pages/copilot/`: `CopilotBoard.vue` (header, top strip, tabs in the URL as `?tab=`), the five tab components, and `boardMeta.ts` (`useBoardRefresh`: on the signal, debounced, and every minute).
  - Route `/copilot` and a **Copilot board** sidebar entry in Workspace (agents who work tickets).
- **Checked in headless Chrome on tbo.localhost**, as a temporary agent removed afterwards: every tab, light and dark, 1440 px and 390 px, with no console errors. The real local data showed 3 investigating, 14 with the customer, 16 fixing and 3 needing a person. One bug was found and fixed: the first column was 2 px wide on wide screens (`lg:grid-cols-none`).
- **H33.** `docs/tbo-copilot.md` has a Copilot board section.

**Deviation:** decision 3 said the TBO Copilot sidebar item gets "Board" and "Chat". That item is a single button that opens the chat panel, so the board is a separate **Copilot board** entry next to Stand-up, and the TBO Copilot button still opens the chat.

**Note:** the desk build needs `NODE_OPTIONS=--max-old-space-size=8192` on the Mac. With the default heap it runs out of memory while bundling.

**Next:** redeploy the demo hub (includes Phase 9 and the Teams fix button), then run the checkpoint above.
