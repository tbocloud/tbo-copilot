# Phase 9: Copilot watches customer errors and remembers known issues

Status: plan written 28 Oct 2026; **approved 28 Oct 2026 (all eight decisions as recommended)**; **built 28 Oct 2026** (see As built); the checkpoint on the demo bench is next.

Owner's choice (28 Oct 2026): from the "Later" list, **error watch + memory** first (over the `/copilot` board,
Microsoft sign-in and Press UAT).

## Goal

1. **Error watch:** Copilot notices a new error on a customer's site and opens a ticket for it, with the evidence,
   before the customer reports it. Copilot then investigates it like any other ticket.
2. **Known-issue memory:** Copilot remembers each error it has dealt with: where it was seen, the root cause, the fix
   and whether each site has that fix. A repeat is recognised at once, a fix that did not reach a site is pointed
   out, and an error that comes back after its fix is raised as a regression.

## What exists today, and what it means for this phase

- **The site can already report its errors.** The connector on every customer site has `get_deploy_status(since)`,
  which returns the top 10 error **signatures** (`app | method | last line of the error`) with counts, and
  `get_error_log(since, until, method, limit)`, which returns the samples with their app and top frames. The
  deploy check (`verify.py`) already uses both. So the watch needs **no change on customer sites**.
- **The hub already knows every site**: the site cards (HDS Site Registry: customer, connection, apps and deployed
  commits) and the customer's Copilot level.
- **Raising a ticket and starting Copilot** is already done by "new work" from Teams (Phase 6): a ticket for the
  customer's contact, no acknowledgement email, then `runs.start_run`.
- **Releases (Phase 7)** know which commit each site runs, and the deploy check finds new error signatures after a
  deploy.
- **What is missing:** nothing looks at customer errors between deploys, and nothing remembers an error after its
  ticket is closed. The Phase 6 checkpoint also showed that the worker trusts old errors. Ticket 0101 was diagnosed
  from an error logged on 27 Oct, although the fix had gone live on 28 Oct.

## Decisions (approved 28 Oct 2026, all as recommended)

1. **What the customer sees of a watch ticket.** *(Recommended: nothing until a person replies.)* The ticket is for
   the customer (their contact as the raiser), but it gets no acknowledgement email and Copilot's stage messages
   stay off until an agent replies or the fix goes live. Alternative: tell the customer at once ("we noticed an
   error and are looking at it").
2. **What counts as a new error.** *(Recommended.)* A signature the site has not had in the last **14 days** that
   happened at least **3 times** since the last check, or for at least **2 different users**. An error in
   accounting, stock or payroll code counts after **1** occurrence. Values are digits-stripped, so "row 12" and
   "row 13" are one error. The first check of a site only records what is there (a baseline), with no tickets.
3. **Which customers.** *(Recommended: a per-customer switch, off by default.)* **Watch errors** on HD Customer,
   switched on for Alpha Trading and Beta Services (the demo customers) first, then for pilot customers one by one.
4. **Limits.** *(Recommended.)* A check every **15 minutes** per site. At most **3** watch tickets per site and **10**
   in total a day; beyond that, one summary note to the Agent Managers. The watch itself uses no AI; each
   investigation counts toward the monthly budget as usual.
5. **What memory is shared between customers.** *(Recommended: code facts only.)* A known issue is matched by app
   and signature across all sites running that app. It keeps only code-level facts: the signature without values,
   the app, the root cause category, the fix pull request, the changed files and the merge commit. Never another
   customer's ticket text, records or Copilot's summary. Alternative: memory per customer only.
6. **An error that comes back after its fix** (a site that has the fix commit and shows the error again).
   *(Recommended.)* The known issue is reopened, and a High-priority ticket "came back after the fix in PR #…" goes to
   a senior approver.
7. **A fix that did not reach a site** (the error appears on a site that runs a commit without the fix).
   *(Recommended.)* No new investigation. The ticket says which fix is missing, and the release flow (Phase 7)
   offers that site's release for approval as usual.
8. **Knowledge base.** *(Recommended: offered, never published.)* When a known issue's ticket is resolved with a
   customer-side cause (`question`, `customer_mistake`, `wrong_setting`), the Copilot dialog offers **Draft a KB
   article** through the existing `kb_drafts.draft_article`. An agent reviews and publishes it. Nothing for code
   bugs.

## What you will see at the end

- An error starts on demo-beta. Within 15 minutes there is a ticket **"Copilot noticed: <the error>"** for Beta
  Services, with when it started, how often it happened, for which users, the documents it hit and the code lines.
  Copilot is already investigating, and the customer's developer sees the diagnosis in Teams.
- The customer then reports the same problem through the Support button. Their ticket is linked to the known issue,
  and the investigation starts with what is already known.
- The fix merges and deploys. The known issue becomes **Fixed**, and demo-beta's row says "has the fix".
- If the error returns on demo-beta after that, a **came back** ticket goes to a senior.
- The Copilot dialog on any linked ticket shows **Known issue**: first seen, sites, tickets, fix, and which sites
  have it.

## What changes, part by part

### H28 (helpdesk): the error watch (≈ 3 days)

- `copilot/watch.py`, cron every 15 minutes, one site at a time:
  1. **Site selection.** Each site card with a connection whose customer has **Watch errors** on and Copilot
     enabled.
  2. **The check.** `get_deploy_status(since=last check)` through `MCPClient`, then each signature normalised:
     digits become `#`, and the connector's own errors and the **Ignored errors** patterns are left out (default:
     `helpdesk_client`, `Session Stopped`).
  3. **Recording.** A new doctype, **HDS Site Error**: site card, signature, its normalised hash, app, first seen,
     last seen, count, users, known issue, ticket. On the first check of a site, the last 14 days are recorded as
     the baseline.
  4. **A new error** (decision 2) gets up to 5 samples from `get_error_log(since, method)`: time, document, top
     frames. Then a ticket for the customer: subject "Copilot noticed: …", the samples in the description, source
     `Error watch`, no acknowledgement (decision 1). Then `runs.start_run`.
  5. **Watch news.** The people the customer's tickets go to (the assigned developer, else the Agent Managers) get
     it in Teams or the panel (`assistant.send`).
- HD Ticket gets `custom_copilot_source` (Customer, Error watch, Teams, …) and `custom_known_issue`.
- Settings (HDS Copilot Settings → Error watch): on/off, minutes, the thresholds of decision 2, the daily caps,
  Ignored errors. HD Customer: **Watch errors**.
- A site that does not answer is skipped and tried at the next check. After 4 failures in a row, the site card says
  so (no ticket).

### H29 (helpdesk): known-issue memory (≈ 2.5 days)

- A new doctype, **HDS Known Issue** (`TBO-KI-.YYYY.-.#####`):
  - normalised signature, app, repository, title;
  - root cause category, status (Open, Fixed, Not a bug);
  - fix pull request, merge commit, fixed at, KB article;
  - child table **HDS Known Issue Site**: site card, customer, first seen, last seen, count, ticket, has the fix.
- **Filled by:**
  - the watch, which creates or updates it per signature;
  - the router, when a diagnosis names error signatures (the worker's new `error_signatures`, W12), which links the
    run;
  - the fix path: a merged Copilot or developer fix of a linked run makes it **Fixed** with the merge commit, and
    the release's deploy check marks each site that runs a commit including it.
- **Used by:**
  - the worker's run context (`known_issues`: code facts only, decision 5);
  - the watch (decisions 6 and 7);
  - the Copilot dialog's **Known issue** section;
  - the staff assistant's questions ("is this a known issue?", "which sites still lack the fix for TBO-KI-…?");
  - **Draft a KB article** (decision 8).
- "Has the fix" is a GitHub compare between the site's commit and the merge commit (`github.compare`, cached per
  pair).

### W12 (worker): known issues and the age of errors (≈ 1.5 days)

- The run context's `known_issues` go into `context/known_issues.md`. The prompt: check them first; when one
  matches and the site lacks its fix, say so instead of writing a new fix.
- The context gets the site's **last deploy time** per app (from the site card). The prompt: an error older than the
  last deploy may already be fixed, so look for one after it or reproduce it first. This addresses the ticket 0101
  lesson.
- `submit_investigation` gets an optional `error_signatures` (list of strings). The worker fills it from the error
  logs it used.

### H30 (helpdesk): the dialog, the report, the docs (≈ 1 day)

- The Copilot dialog's **Known issue** section and the **Draft a KB article** button.
- The Copilot Pilot report and the Monday email get new lines: errors watched, watch tickets, repeats recognised,
  fixes missing on a site, came-back issues.
- Docs: `docs/tbo-copilot.md` (Error watch, Known issues); the worker's `docs/tbo/`.

## Out of scope (later)

- Errors on TBO's own sites (the hub, Press). This phase covers customer sites only.
- Slow pages, failed background jobs and email queue failures. Errors only for now.
- Opening one ticket per error for several customers at once (a "platform incident"). Each site gets its own ticket,
  all linked to one known issue.

## How it is built, run and tested

- Built on the Mac like earlier phases. Module tests run with `hold_commits` on tbo.localhost (the watch against a
  fake connector, thresholds, baseline, caps, ignored errors, the known issue's life, has-the-fix, came back,
  missing fix, sharing only code facts), plus the worker's unit and end-to-end tests for W12.
- Helpdesk goes into `tbo-copilot` (pushed under the standing instruction); W12 is a pull request into `tbo`.
- No change on customer sites, so no helpdesk_client release.

## Checkpoint (on the demo bench)

1. A planted error in demo-beta's app (the owner's OK at that time, merged and released like demo-alpha's).
   Hitting it 3 times gives a "Copilot noticed" ticket for Beta Services within 15 minutes, with no email to the
   customer. Copilot investigates, and the diagnosis reaches Teams.
2. The same error reported by the customer is linked to the known issue, and the worker's context shows it.
3. The fix merges and is released. The known issue is Fixed, and demo-beta has the fix.
4. Undoing the fix brings the error back. A "came back" ticket goes to a senior.
5. Errors from the connector and the ignore list make no ticket, and the daily cap holds.
6. A resolved customer-side ticket offers a KB draft; nothing is published by itself.

## Risks

- **Noise: too many tickets.** Mitigation: the baseline, the thresholds, the ignore list, the daily caps, per-customer
  switch, and the digits-stripped signature.
- **One customer's data in another's context.** Mitigation: the known issue keeps code facts only (decision 5),
  tested.
- **The customer is surprised by an email.** Mitigation: no acknowledgement and no stage messages until a person
  replies (decision 1).
- **Load on customer sites.** Mitigation: one small call every 15 minutes (500 rows at most, already used by the
  deploy check); a site that fails is skipped.
- **Cost.** The watch uses no AI. Investigations count toward the monthly budget, and the daily cap limits them.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| The approval of this plan and its 8 decisions | everything | now |
| OK for a planted error on demo-beta | checkpoint step 1 | at the checkpoint |
| Which pilot customers get **Watch errors** after the demo | going live | after the checkpoint |

Estimate: about **8 days** (H28 3, H29 2.5, W12 1.5, H30 1).

## As built (28 Oct 2026)

**Helpdesk `tbo-copilot` (pushed):**
- **H28 `copilot/watch.py`.**
  - The cron runs every 5 minutes, and each site is checked after **Minutes Between Checks**.
  - Each site is checked under its own savepoint and committed on its own.
  - **HDS Site Error** rows have the statuses Watching, Ticket, Baseline and Ignored.
  - Tickets are raised with `custom_copilot_source` "Error watch" and `custom_known_issue`, and with `flags.skip_acknowledgement`.
  - `watch.held(ticket)` holds every stage except Resolved until a Sent Communication exists. `customer.send_stage` records the stage event with `held`.
  - A "missing fix" ticket sets `flags.no_copilot_run`, which `runs.on_ticket_insert` respects.
  - The site card has **Errors Checked At**, **Checks Failed in a Row** and **Watch Note**. HD Customer has **Watch Errors**.
  - Settings: the Error Watch section.
- **H29 `copilot/known_issues.py`.**
  - New doctypes HDS Known Issue (`TBO-KI-…`) and HDS Known Issue Site, plus HDS Copilot Run `known_issue`.
  - **Has the fix:** a `github.compare` from the merge commit to the site card's commit, cached a day.
  - `fixes.on_merged` marks an issue Fixed, behind a savepoint.
  - The router calls `link_run`. `customer_erp_read` remembers the signatures `get_error_log` returned, and only those count from the worker's `error_signatures`.
  - The run context gets `known_issues`, `raised_by_copilot` and `site.deploys`.
  - Customer-side causes make an open issue Not a bug.
- **H30.**
  - The dialog has a Known issue section and a **Draft a KB article** button (`api.copilot.draft_known_issue_article`).
  - The staff chat's answers include the known issue.
  - The Copilot Pilot report and the Monday email gain **Error watch tickets** and **Known repeats**.
  - `docs/tbo-copilot.md` has the Error watch and Known issues sections.
- **Tests:** `test_copilot_watch.py` has 16 tests. `test_utils.FakeErrorSite` fakes a customer site's error log. 23 related Copilot modules pass; no leftovers.

**Helpdesk_client `tbo-copilot` (pushed):** `get_error_log` also returns `owner`, the user an error happened to.
- This departs from "no change on customer sites". It is needed only for decision 2's "2 users" rule; without it the watch counts occurrences only.
- `test_diagnostic_tools` passes (10 tests).

**Worker W12: a pull request** into `tbo`.
- It adds `context/known_issues.md` (data in the wrapper; another customer's issue without its signature) and `site.json` `deploys`.
- INDEX.md gets lines for both and a note on watch tickets.
- The prompt reads known issues first, checks the age of errors against the latest deploy, and reports `error_signatures`.
- Unit tests: 141 passed.

**Other deviations:**
- Ignored Errors left blank means "Session Stopped", because an existing settings record gets no default on migrate. The connector's own errors (`helpdesk_client`) are never a ticket, whatever the setting says.
- An expiring cache key must be read with `expires=True`. Without it, Frappe's per-request cache keeps the first "nothing" answer (found by the tests).

**Next:**
1. Redeploy the demo hub with helpdesk and demo-alpha/beta with helpdesk_client, then migrate.
2. Merge a pull request, then rebuild the worker.
3. Switch on **Watch Customer Errors** and **Watch Errors** for Alpha Trading and Beta Services (decision 3).
4. Run the checkpoint, with the owner's OK for a planted error on demo-beta.
