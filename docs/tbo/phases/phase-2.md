# Phase 2: Deploy through Press, with one click

**Status:** approved by the owner 13 Oct 2026: start now against a fake Press, check the real Press and run the demo once the Copilot Press login and a test site exist; the window 21:00 to 06:00 Asia/Riyadh; Deploy Now for senior approvers and Agent Managers only. **H11 and H12 built on the Mac against a fake Press (13 Oct 2026), see As built**; the checkpoint on TBO's Press waits for the Copilot Press login and a test site. **Estimate:** about 11 developer-days: H11 (deploy requests and the Press client, ≈ 5), H12 (verification, undo, site card from Press, ≈ 4), and the checkpoint on TBO's Press (≈ 2). **Design reference:** `../system-design.md` §5.4 (deploy through Press); `../build-plan.md` Phase 2; the pilot rules (a person presses Deploy; automatic deploys only later, for proven low-risk changes). **Built on:** helpdesk `tbo-copilot` (Phase 1d and the hub part of 1c-2, pushed 13 Oct).

## Goal

After the one approval and the merge, a person presses **Deploy** on the ticket. TBO Support updates the customer's site through Press at the agreed time. It then checks that the site runs the merged fix and shows no new errors, and tells the customer "the fix is live, please confirm". When the update or the check fails, the site stays on its old code (Press restores it), the team is told, and **Undo** prepares a revert of the fix for the same one approval.

## What exists today, and what it means for this phase

| Found (13 Oct) | Consequence |
|---|---|
| After the merge a run waits at Merged. An engineer deploys through Press by hand and presses **Mark deployed** (Phase 1d) | Phase 2 replaces the manual step with **Deploy** for sites on TBO's Press. Mark deployed stays for sites outside it |
| The run's state list already has Deploying and Verifying, without transitions | This phase adds them |
| The site card has `press_site` and `press_release_group`, still empty; there is no Press login for Copilot | The Press client needs a Copilot Press user and its API key; the cards get the Press names once |
| Press's API (checked on frappe/press, 13 Oct): `bench.deploy_information(group)` (each app's current and next commit, the group's sites, whether a deploy is running); `bench.fetch_latest_app_update(group, app)`; `bench.deploy_and_update(group, apps, sites, run_will_fail_check, trigger_patch_deploy)`; `site.backup`, `site.backups`; `client.get_list` on Deploy Candidate, Site Update, Agent Job and Site Backup | All we need exists. `deploy_and_update` returns a Deploy Candidate in the older flow and a Release Pipeline in the newer one: **which one TBO's Press uses is checked first**, with the Copilot login |
| Press refuses a deploy while another runs on the same bench, and restores a site whose update fails | The hub keeps one deploy at a time and treats Press's own recovery as the first rollback |
| The connector already reads the site's code identity, error log and deploy status (Phase 1b) | The verification after a deploy needs no new connector code |
| GitHub can create a revert of a merged pull request (`revertPullRequest`, GraphQL) | Undo needs no worker: the hub asks GitHub for the revert pull request with the GitHub App, and Phase 1d follows it |

## Decisions in this plan (please confirm)

| # | Topic | This plan | Why |
|---|---|---|---|
| 1 | When | **Deploy** offers **Tonight** (the next deploy window, 21:00 to 06:00 Riyadh time, a setting) or **Now**. Now is for senior approvers and Agent Managers only | Builds strain live sites; the night is quiet. Urgent fixes still go out |
| 2 | How | Press's normal update (`deploy_and_update`: a new build, then the site moved to it, Press's own backup first, never skipped), not Press's in-place update | The documented path with backups and Press's recovery; in-place updates can be weighed after the pilot |
| 3 | Which sites | Only the sites on the ticket customer's site card. Other sites on the same bench stay on their old code until their own update, and the card lists them. If another customer's site shares the bench, only a senior may press Deploy | A shared bench moves code for others too |
| 4 | One at a time | One deploy at a time across TBO's Press (a lock), and none while Press reports a deploy running on that bench. A deploy that cannot start waits up to an hour, then is rescheduled for the next window | As Press itself works, and as the build plan asked |
| 5 | The check after | Through the connector: the site runs the merged commit; no new error signatures since the deploy began (the connector's own noise left out); the scheduler is on; the pages, documents and reports the ticket names still open. Within 30 minutes | Proof from the live site, not from Press's status alone |
| 6 | When it fails | Press's failure (the site restored by Press) or a failed check sets the run to **Escalated**, tells the approver, the developer and the Agent Managers with Press's links, and lists the backup taken. **Undo** then asks GitHub for a revert pull request, which goes through the same one approval and may be deployed Now. Database restores stay manual | Code goes back by the same safe road it came; data is a person's decision |
| 7 | Mark deployed | Stays, for sites not on TBO's Press or deployed by hand | Not every customer is on TBO's Press |
| 8 | Automatic deploys | The setting **Auto-deploy categories** is built and left **empty**. Filling it later lets approved low-risk fixes (for example print formats or reports) deploy in the window without a click | The pilot rule: automatic only after several clean deploys |

## What you will see at the end (the demo, on TBO's Press)

1. A practice fix (the rehearsal app from 1c-2, installed on a Press test site) is approved and merged as in Phase 1d.
2. On the ticket, **Deploy, Now**. The card shows the deploy:
   - **Waiting for Press:** the merged commit registered on the bench.
   - **Deploying:** Press's build and the site update.
   - **Checking:** the site runs the commit, no new errors, the named page opens.
   - **Done.**
3. The customer's ticket says the fix is live and asks them to confirm. Confirm closes it, as in Phase 1a.
4. **Tonight:** another fix is scheduled for the window. It waits, then goes out at 21:00 without anyone pressing anything more.
5. **A failing deploy:** a fix with a patch that fails is approved and deployed. Press restores the site, and the run becomes Escalated, with Press's links and the backup named. **Undo** opens the revert pull request; it is approved, merged and deployed, and the site is back on the earlier code.
6. **The rules hold:** a second deploy waits for the first; Now is refused to a non-senior; a site sharing its bench with another customer's site needs a senior.

## What changes, PR by PR

### H11 (helpdesk): deploy requests and the Press client (≈ 5 days)

| Item | Detail |
|---|---|
| Settings (HDS Copilot Settings) | **Press**: URL, API key and secret (Password). **Deploys**: window start and end, timezone, who may deploy now (seniors and Agent Managers), the auto-deploy categories (empty), the check's time limit (30 min) |
| `copilot/press.py` | A typed client: `deploy_information`, `fetch_latest_app_update`, `deploy_and_update`, `backups`, and `get_list` on Deploy Candidate, Release Pipeline, Site Update, Agent Job. Errors carry Press's own message. Every call is an event on the run |
| **HDS Deploy Request** (`TBO-DEP-.YYYY.-.#####`) | run, ticket, approval; status (Scheduled, Waiting for Press, Deploying, Checking, Succeeded, Failed, Cancelled); requested by and at; now or tonight, scheduled for; release group; **sites** (site, Press update, status, backup) and **apps** (app, from commit, to commit); Press's reference (candidate, pipeline or agent job); started and finished; the check's results; the error |
| Run transitions | Merged → Deploying (hub, when the deploy starts); Deploying → Verifying (hub, Press done); Verifying → Resolved (hub, the check passed); Deploying or Verifying → Escalated (hub, failed); Deploying → Merged (hub, it could not start and was rescheduled) |
| `copilot/deploy.py` | `request_deploy(run, when, user)` (who may, which sites, the window). The cron every 5 minutes, `run_due`: the lock; Press's deploy information (nothing running; the merged commit registered on the bench, else fetch it and wait up to an hour); `deploy_and_update` for the customer's sites only, with backups; then it follows Press until the site updates finish |
| Card and dialog | **Deploy** (Tonight or Now) once the fix is merged; the deploy's progress; the other sites on the bench; Cancel while it waits. "Fix scheduled" tells the customer the real date and time |
| Tests | `test_copilot_deploy.py` with a fake Press: who may deploy and when; the window; the lock; the commit not yet on Press; the update and its statuses; Press's failure and recovery; only the customer's sites updated; the shared-bench rule |

### H12 (helpdesk): the check after, Undo, the site card from Press (≈ 4 days)

| Item | Detail |
|---|---|
| `copilot/verify.py` | Through the connector: `get_code_identity` (the app runs the merged commit); `get_error_log` since the deploy began, minus the connector's own noise and the ignored titles; `get_deploy_status` (scheduler, patches); the documents and reports the diagnosis names (`get_doc`, `execute_report`). Results as rows (pass, fail, not run) on the deploy request and the card |
| After the check | Passed: the run is Resolved and the customer is asked to confirm (the existing stage). Failed: Escalated, the people told, **Undo** on the card |
| Undo | `revert(run)`: GitHub's `revertPullRequest` with the GitHub App opens the revert pull request, saying `Refs` to the task and naming the run. Phase 1d follows it (hold, one approval, the merge), and its Deploy may be Now |
| Site card | **Refresh from Press**: the release group's apps and their deployed commits, the group's other sites, and drift against the site's own code identity |
| Docs | `docs/tbo-copilot.md`: deploying, the window, the check, Undo; a runbook for a deploy that went wrong |
| Tests | `test_copilot_verify.py` (each check, the connector refusing, the noise filtered); Undo (the revert pull request followed by 1d); the site card from Press |

## Out of scope (later)

- Automatic deploys: the setting is built but stays empty until the pilot shows clean deploys.
- Press's in-place updates.
- Restoring a database from a backup: a person's decision, with the backup named.
- Several deploys at once.
- Deploys to customers outside TBO's Press: Mark deployed covers them.
- The deploy train (several approved fixes for one bench going out together).

## How it is built and tested

- helpdesk `tbo-copilot`: module tests on tbo.localhost with `hold_commits` and a fake Press, leftovers checked after each batch.
- **First, with the Copilot Press login:** read-only calls on TBO's Press (`deploy_information` on the test bench, `backups` on the test site) to confirm the shapes and the deploy flow before the first real deploy.
- The checkpoint runs on a Press test site, never on a customer's site, until you say so.

## Checkpoint (demo on TBO's Press)

1. Deploy Now of an approved practice fix: Press updates the test site, the check passes, the customer's stage says live, Confirm closes.
2. Deploy Tonight: it waits, then deploys in the window by itself.
3. A failing patch: Press restores the site, the run is Escalated with the links and the backup; Undo's revert pull request is approved, merged and deployed.
4. One at a time, Now for seniors only, and the shared-bench rule, shown.

## Risks

- **Press's API is internal and changes.** The calls are in one module; their shapes are checked on TBO's Press first, and Press's own message is shown on any refusal.
- **Builds strain live sites.** The night window is the default, and one deploy runs at a time.
- **A broken update.** Press restores the site, and Undo reverts the code. Data changed by a failed patch needs a person and the backup, so the escalation names it.
- **The check misses a problem.** It checks what the ticket names, the error log and the commit, not every screen. The customer still confirms, and reopening goes to a person.
- **A shared bench.** Other sites stay on old code until their own update. Press's own auto-update may move them later; the card says so.
- **The Press key is powerful.** Press has no narrower role, so the key stays on the hub, Press's API should accept it only from the hub's address, and every call is logged.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| A Press user for Copilot in TBO's Press team, with an API key and secret, and Press's API limited to the hub's address if your nginx allows it | H11 | first |
| A Press test bench and site for the checkpoint, where the practice app can be installed | the checkpoint | before the checkpoint |
| For each pilot customer: the Press site name and release group on their site card (the pilot customer first) | live use | before the first real deploy |
| The deploy window and timezone (default 21:00 to 06:00, Asia/Riyadh), and who may deploy Now (default: senior approvers and Agent Managers) | H11 | any time |
| The GitHub App (from 1c-2), for Undo's revert pull requests | H12 | before Undo is used |

## As built (13 Oct 2026, helpdesk `tbo-copilot`, local commit)

**Code.** `copilot/press.py` (the client), `copilot/deploy.py` (requests, window, lock, the cron `run_due` every 5 minutes, Press's steps, failure and success, automatic deploys), `copilot/verify.py` (the check after), `fixes.undo` with `github.revert_pull` (GraphQL `revertPullRequest`), `registry.refresh_from_press`; doctypes HDS Deploy Request (`TBO-DEP-.YYYY.-.#####`), HDS Deploy Site, HDS Deploy App; settings sections Press and Deploys; run fields `deploy_request`, `reverts`; site card field **Other sites on the bench**; the card's Deploy (Tonight or Now), Cancel deploy, the deploy's rows, **Undo the fix** (with a reason); **Refresh from Press** on the site card; `docs/tbo-copilot.md` (deploying, the check, Undo, automatic deploys, a runbook).

**Tests** (fake Press, fake GitHub, fake customer site; all pass on tbo.localhost with `hold_commits`): `test_copilot_deploy` 17 (when and where, Now for seniors, the commit reaching Press first, one at a time, rescheduling, cancel, the card, the shared bench, the check after, Press's failure with its links and backup, Undo end to end, automatic deploys and their limits), `test_copilot_verify` 5 (signatures, the named documents, a document that no longer opens, a site that does not answer, no connection), `test_copilot_press` 4, `test_site_registry` +2 (Refresh from Press). The other Copilot, GitHub and task modules pass unchanged.

**Where it differs from the plan**

| Plan | As built | Why |
|---|---|---|
| Deploying → Merged when a deploy cannot start | Not needed: the run stays Merged until Press accepts the deploy; the request waits (Waiting for Press), then moves to the next window | Simpler; the run's state says what really happened |
| Follow Press's Deploy Candidate or Release Pipeline | The hub follows each site's **Site Update** (by site, since the deploy began) and keeps Press's answer as the reference | The same in Press's old and new deploy flows |
| `backups` and `site.backup` calls | Press's own backup in its update (never skipped) is used; the backup's name is read from the Site Update (`site_backup`, best effort) and named with a link to Press's update when a deploy fails | One backup, Press's; no second backup call |
| The check runs reports the diagnosis names (`execute_report`) | Documents only (`get_doc`, at most 3) | The diagnosis names documents; reports later |
| A bench that already runs the merged commit | Goes straight to the check | Someone deployed it by hand or Press auto-updated it |
| Auto-deploy categories | Built: a merged fix whose root cause or risk level is listed is scheduled for Tonight on its approver's behalf; never a sensitive or high-risk fix, an undo, or a shared bench. Empty, so off | As decided (#8) |

**To confirm first on TBO's Press** (read-only, with the Copilot login), before the first real deploy:

1. The Press version and the shapes: `deploy_information` (apps with `source`, `release`, `hash`, `next_release`, `next_hash`; `sites`), `deploy_and_update`'s arguments, whether Press Settings use the new deploy flow, and `client.get_list` on Site Update for the team (with `site_backup`).
2. **Which Press team owns the customers' sites.** If each customer has its own team on TBO's Press, the Copilot user must be able to act for those teams (a team per site card, or a Press administrator user); the client sends one team today.
3. Whether Press's web server can accept the Copilot key only from the hub's address.

## Checkpoint passed (17 Oct 2026, demo sites on TBO's Press)

The whole path on real infrastructure, one of the demo scenarios (a bug in the demo app):
- **Ticket and investigation:**
  - a ticket raised on the demo customer site → a hub ticket;
  - investigated by the worker on the AWS server: bug, confidence 0.98, the exact line, about
    1 minute, $0.004.
- **Fix and approval:**
  - the fix's pull request (the code, its tests and a patch for stored values), CI and CodeRabbit green;
  - the approval (high risk, senior), approved by Administrator;
  - merged by the GitHub App.
- **Deploy** (Now, by the senior), 11:25 → 11:45 IST:
  - one Press pipeline;
  - its Site Update Success on the demo customer site only;
  - check after: the merged commit runs, no new errors, scheduler on;
  - run Resolved, the customer asked to confirm.
- **Result on the site:** the figures and the report the customer named are right.

Found on the way and fixed:
- the worker needs `TBO_MODEL_API_STYLE=responses` for gpt-5.6-luna (OpenAI refuses tools with reasoning on Chat
  Completions);
- the hub read Press's `deploy_information` with invented field names (`hash`, `next_hash`); Press sends
  `current_hash`, `next_release` and `releases`. Helpdesk; FakePress now answers in Press's shape;
- the demo hub needed a customer project for the fix task.

Polish for later:
- the customer got "Fix scheduled" three times (the first try, the move to the next window, the reschedule): send it
  once per new date;
- the first failed run left a "With our team" step before the re-run.
