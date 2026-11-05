# Phase 1d: One approval, then the merge

**Status:** approved by the owner 12 Oct 2026 (the repository's own merge method; the demo on a new private sandbox repository). **Built and tested 12 Oct 2026**, committed locally on helpdesk `tbo-copilot`, not pushed; the live demo waits for a GitHub token and working CI on the sandbox (see As built). **Estimate:** about 9 developer-days, two pull requests (H7 and H8 in helpdesk). **Design reference:** `../system-design.md` §5.1 (the one approval, Task and PR linkage), §5.3 (GitHub pipeline); `../build-plan.md` Phase 1d. **Built on:** helpdesk `tbo-copilot` (main merged in); Phase 1c-1 (shadow mode, diagnosis rating).

**Checkpoint passed, 15 Oct 2026:** the owner approved the demo fix on ticket 0101 (senior: Administrator). TBO Support merged the pull request on TBO's private sandbox repository **through the TBO Copilot GitHub App** (merged and authored by the App's bot); the run went Approved → Merged → "Fix scheduled". A second click on Approve during the merge was refused by the first-decision guard with a misleading message; fixed in helpdesk `tbo-copilot` (the button ignores clicks while sending; a late decision says who decided first). The App key pasted into the one-line setting needed a helpdesk fix.

## Goal

A code fix for a Copilot ticket goes live only after one person approves it, from a short card on the ticket. The approval is bound to the exact code that was reviewed. The hub then merges the pull request, the ticket shows "Fix merged", the engineer deploys it as today and marks it deployed, and the customer is told.

## What exists today, and what it means for this phase

| Found in the code (survey of 12 Oct) | Consequence |
|---|---|
| GitHub sync links a pull request to a Task when its title or description says `Closes TASK-…`, and reaches the ticket through the Task. Webhooks only, no polling | A Copilot fix needs a Task, and the hub needs its own refresh for the few Copilot pull requests |
| The sync stores neither the pull request's head commit, nor its base, nor the merge commit, and ignores new pushes (`synchronize`) | An approval cannot yet be tied to the code that was reviewed |
| **The org merge bot** (`tbocloud/ai-review`) merges every open pull request in tbocloud and teambackoffice that CodeRabbit approved, with green checks and a clean merge state. It skips drafts and pull requests labelled **`no-auto-merge`**. It pins the head commit and uses the repository's merge method (merge commit where allowed) | Without a hold, the bot would merge a Copilot fix before the one approval |
| helpdesk's own `auto-merge.yml` turns on GitHub auto-merge for every pull request, unless it is labelled `no-auto-merge`. The customer repositories have no such workflow; a customer app has no CI at all | The same label holds both |
| When a `Closes` pull request merges, the sync already adds "Fix merged in PR #N" to the ticket and completes the Task, whose completion adds "Task X was completed. Reply to the customer." | The hub must not add a third note, and the second one is wrong for a Copilot fix |
| Runs stop at Preparing Fix: no Task, no pull request, no approval. The run's state list already has Awaiting Approval, Approved, Merged and Resolved, without transitions | This phase adds the transitions |
| Teams messages can only carry a link, no buttons | The approval happens on the ticket page; Teams brings the approver there |
| HD Agent has no senior-approver field; HD Team has no lead | The approvers and the seniors are a list in Copilot settings |

## Decisions in this plan that differ from the design (please confirm)

| # | The design said | This plan | Why |
|---|---|---|---|
| 1 | The worker opens the pull request | Until Phase 1c-2, a developer opens it, from a **Copilot fix task**; the same approval works unchanged for the worker's pull requests later | The worker cannot push code before the VM and the GitHub App exist |
| 2 | The hub merges by squash | The hub merges with **the repository's own method, as the org merge bot chooses it** (merge commit where allowed, else squash, else rebase) | One rule for every merge in the organisation; Phase 2's revert handles merge commits (`revert -m 1`). Say if you prefer squash for Copilot fixes |
| 3 | Only the hub merges | The hub puts the **`no-auto-merge` label** on every Copilot pull request, which keeps the org merge bot and the auto-merge workflow off it until the one approval; then the hub merges it itself | The bot and the workflow already honour this label |
| 4 | A fix task at the start of every code run | Live runs get the fix task automatically at Preparing Fix; in **shadow mode** an agent creates it from the Copilot dialog (after rating the diagnosis) | Shadow mode creates nothing by itself |
| 5 | Run states Merging and Rejected | Not used: the merge is one call, and a rejection sends the run back to Preparing Fix with the reason | Fewer states to keep right |
| 6 | Webhooks only | Webhooks, plus a **10-minute refresh** of open Copilot pull requests and a Refresh button on the card | The sync never polls, a missed webhook would leave an approval stale, and the local hub cannot receive webhooks |
| 7 | AI review must pass | Every check must be green (the AI review is a check where the repository has one); CodeRabbit's own approval is shown but not required | The person's approval is the gate |
| 8 | Deploy in Phase 2 | Unchanged: an engineer deploys through Press by hand, then presses **Mark deployed**; the customer is told then | As agreed for the pilot |

## What you will see at the end (the demo)

1. A Copilot run on a seed ticket finds a bug and stops at Preparing Fix. In the Copilot dialog the agent rates it Right and presses **Create fix task**: Task "Copilot fix: …" in the customer's project, assigned to the customer's developer, with the diagnosis and "open a pull request that says `Closes TASK-…`".
2. The developer opens the pull request (a draft while working). When it is ready for review:
   - the hub links it to the run, labels it `no-auto-merge`, and works out its risk from the changed files;
   - it creates the approval for the head commit and assigns an approver;
   - the approver gets a Teams message (or an email) with a link to the ticket.
3. On the ticket, **Review fix** in the Copilot dialog shows: the cause, the pull request and its files, the risk and why, the checks, CodeRabbit's verdict, the message the customer will get, and Approve, Reject and Open PR.
4. **Approve**, with the planned deploy date. The hub checks that the head commit is still the approved one and the checks are green, then merges with that commit pinned. The ticket shows "Fix merged"; the Task completes with "deploy it, then press Mark deployed"; a live customer sees "A fix is ready and will go live on <date>".
5. After the manual Press deploy, **Mark deployed**: the run is Resolved and the customer is asked to confirm or reopen (Phase 1a).
6. **The rules hold:**
   - a push after the approval replaces it with a new one for the new commit;
   - a change touching accounting, stock, payroll, permissions, patches, `hooks.py`, doctype JSON, dependencies or CI can be approved only by a senior approver;
   - the developer who made the fix cannot approve it;
   - a second click says "already approved by X at T";
   - Reject asks for a reason, which goes to the Task and the pull request, and the run goes back to Preparing Fix;
   - a pull request merged without the approval is recorded as such and the Agent Managers are told.

## What changes, PR by PR

### H7 (helpdesk): the approval (≈ 4.5 days)

| Item | Detail |
|---|---|
| **HDS Copilot Approval** (`TBO-APR-.YYYY.-.#####`) | run, ticket, pull request (Link HD Pull Request), repository, number, `head_sha`, base branch; `status` Pending / Approved / Rejected / Superseded / Merged / Failed; `payload` (JSON: files, additions, deletions, risk, reasons, checks, CodeRabbit verdict, customer message) and `payload_hash`; `risk_level`, `sensitive`; `assigned_to`, `assigned_at`, `reminded_at`, `escalated_at`; `decided_by`, `decided_at`, `decided_via`, `note`, `deploy_date`; `merge_commit`, `merged_at`, `merge_error` |
| HDS Copilot Settings | **Copilot approvers** (child table: user, senior, active); `approval_reminder_hours` (default 4); `approval_escalate_hours` (default 24) |
| HDS Copilot Run | `pull_request`, `approval`, `merge_commit`, `deployed_at`, `deployed_by` |
| `helpdesk/copilot/approvals.py` | `open_for(run, pull_request)`: payload, hash, risk, assignment, notification. `decide(approval, approve, note, deploy_date)`: row lock, first wins, senior and self-approval rules, head commit re-read from GitHub, a changed head supersedes. `supersede(...)`, `remind_and_escalate` (cron every 15 minutes) |
| Assignment | The customer's assigned developer, unless they wrote the fix; else the least loaded active approver (fewest pending, then least recently assigned); a sensitive change only to a senior; nobody in the list → the Agent Managers |
| Run transitions | Preparing Fix → Awaiting Approval (hub); Awaiting Approval → Approved (agent); Awaiting Approval or Approved → Preparing Fix (agent: reject; hub: pull request closed); Approved → Awaiting Approval (hub: new commits); Approved → Merged (hub); Awaiting Approval → Merged (hub: merged elsewhere, flagged); Merged → Resolved (agent: Mark deployed); Resolved → Closed or Escalated (customer, agent). Awaiting Approval and Approved can be cancelled |
| Customer stages | Merged → "Fix scheduled" with the planned date; Resolved → "Resolved" ("The fix is live"). Shadow runs record them only |
| Fix task | `create_fix_task(run)`: in the customer's open project (else the hand-over project), assigned to the customer's developer, `pause_ticket=False`, with the diagnosis, the evidence and the `Closes TASK-…` instruction. Automatic at Preparing Fix for live runs; a dialog button for shadow runs |
| API | `helpdesk.api.copilot.create_fix_task`, `decide_fix` (approve with deploy date, or reject with a reason), `refresh_fix`, `mark_deployed`; `get_run` returns the fix task, the pull request and the approval card |
| Copilot dialog | **Create fix task**, **Review fix** (the card, Approve, Reject, Open PR, Refresh), **Mark deployed**; the existing "Approvals" button (write actions on customer sites) is a different thing and keeps its name |
| Notifications | `chat_notifications.send_direct(approver, text, ticket link)`, else email through `notify_users`; sensitive ones also to the channel (`post_to_channel`); reminders and escalation from the cron |
| Tests | `test_copilot_approvals.py`: assignment, senior rule, self-approval, first wins, supersede, reject, reminders and escalation, permissions; `test_copilot_fix_flow.py`: the whole flow with a fake GitHub |

### H8 (helpdesk): GitHub, risk and the merge (≈ 4.5 days)

| Item | Detail |
|---|---|
| HD Pull Request | New fields `head_sha`, `base_branch`, `merge_commit_sha`, filled by `refresh_row` from every pull-request event; `synchronize` now refreshes the row too. Additive: nothing the sync does today changes |
| The hook into the sync | One call after a pull-request delivery is processed: `helpdesk.copilot.fixes.on_pull_request(rows, action, payload)`. It acts only on rows whose Task is a run's fix task |
| `helpdesk/copilot/github.py` | `get_pull`, `pull_files`, `checks_green` (the bot's rule: every check run completed as success, neutral or skipped, and the combined status success or empty), `merge_method` (the bot's rule), `merge(repo, number, sha)` (PUT `/pulls/{n}/merge` with the approved commit pinned), `add_label`, `remove_label`, `comment`. Errors are raised with GitHub's status and message, never swallowed (405 not mergeable, 409 head moved, 422) |
| The hold | The `no-auto-merge` label on every Copilot pull request from the moment it is linked; removed after the hub's merge (or when the run is cancelled) |
| When to merge | On approval, and again on every check webhook and the 10-minute refresh while Approved: merge when the head is the approved commit, the checks are green and GitHub says the merge state is clean; a lasting block (conflicts, a failed check) is told to the approver and the developer |
| `helpdesk/copilot/risk.py` | From the pull request's files: **high** and **sensitive** for accounting, stock, payroll, tax, permissions (`ignore_permissions`, `has_permission`, role files), `patches.txt` and `patches/`, `hooks.py`, doctype JSON, raw SQL writes, dependency files, `.github/`; high for more than 300 changed lines; **medium** when no test file changed; low otherwise. Each finding names its reason |
| After the merge | No extra ticket note (the sync already adds "Fix merged"); the Task's completion says "Fix merged: deploy it, then press Mark deployed in the Copilot dialog" instead of "Reply to the customer" when the Task is a Copilot fix task (`notify_ticket_task_completed`, one branch) |
| Refresh | Cron every 10 minutes for open Copilot pull requests (head, checks, merge state, merged or closed); the card's Refresh button runs the same |
| Tests | `test_copilot_github.py` (calls and errors against a fake HTTP layer), `test_copilot_risk.py`, the sync's own tests still pass, webhook replays for opened, ready for review, synchronize, check runs, merged and closed |

## Out of scope (later)

The worker opening pull requests (1c-2); the Press deploy, its verification and rollback (Phase 2); config and data change sets with senior approval (Phase 3); a Teams bot with buttons and a Vue card (later).

## How it is built and tested

- helpdesk `tbo-copilot`, two commits (H7, H8), black, isort, strict flake8 and prettier clean; module tests only on tbo.localhost with `hold_commits`; leftovers checked after each batch.
- The local hub cannot receive GitHub webhooks: the demo uses the refresh, and recorded webhook payloads in the tests.
- **The demo repository:** a throwaway private repository (for example `tbocloud/tbo-copilot-sandbox`) holds the demo's pull requests and merges, so no customer code is merged for a test.

## Checkpoint (demo on the local pair)

1. A seed ticket goes from a Copilot diagnosis to a fix task, a pull request on the sandbox repository, the approval card, a Teams or email link, Approve, the hub's merge with the commit pinned, "Fix merged", Mark deployed and the customer's confirmation.
2. A push after the approval supersedes it; a sensitive change waits for a senior; the developer cannot approve their own fix; a second click is refused; Reject sends the reason to the Task and the pull request.
3. While the label is on, the org merge bot's dry run lists the pull request as skipped (`no-auto-merge`).
4. A pull request merged by hand before the approval is recorded as merged without it, and the Agent Managers are told.

## Risks

- **The bot's rules live elsewhere.** If `tbocloud/ai-review` changes its skip label, Copilot fixes could merge unapproved. The label is in one setting, and the test of item 3 above shows it.
- **Token scope.** The hub's GitHub token needs Contents write on the repositories it merges, and the sync must allow those repositories (the customer apps' organisation).
- **Direct merges.** On GitHub's Free plan rules are not enforced on private repositories, so a person can still merge by hand. The hub records it and tells the managers; it cannot prevent it.
- **Customer repositories without CI.** With no checks, "green" means nothing ran; the card says so plainly.
- **Shared code in main.** The sync and the Task controller get small additive changes; they are the helpdesk maintainer's code and each change is one call or one branch.

## What TBO must provide

- Who approves and who is senior, for the approvers list.
- The hub's GitHub token with Contents write (merge) and pull-request write (labels, comments) on the pilot repositories, and those repositories in Settings → GitHub → allowed repositories, with the organisation webhook pointing at the hub.
- A throwaway repository for the demo, or permission to create `tbocloud/tbo-copilot-sandbox`.
- The merge method for Copilot fixes: the repository's own (recommended, like the bot) or always squash.

## As built (12 Oct 2026)

One commit on helpdesk `tbo-copilot` (27 files, about 3,600 lines with tests and doctype JSON; it can be split into the planned H7 and H8 pull requests when the series goes to main). Not pushed.

**What exists:** HDS Copilot Approval (`TBO-APR-.YYYY.-.#####`, statuses Pending, Approved, Rejected, Superseded, Merged) and the Approvers table in HDS Copilot Settings (user, senior, active; Remind after 4 h, Escalate after 24 h, hold label `no-auto-merge`); `helpdesk/copilot/github.py` (strict GitHub client: errors carry GitHub's status), `risk.py`, `approvals.py`, `fixes.py`; the router gives a live bug run its fix task; the GitHub sync tells Copilot after each pull-request delivery and finished workflow (`tell_copilot`, its own savepoint) and keeps head commit, base branch and merge commit on HD Pull Request; the Task note after a merge says to deploy and press Mark deployed; API `create_fix_task`, `decide_fix`, `refresh_fix`, `mark_deployed`; the dialog shows the fix and the review (files, risk, checks, who may decide, deploy date, note); crons `fixes.refresh_open` (10 min) and `approvals.remind_and_escalate` (15 min).

**Changed from the plan while building (self-review):**
- A rejected commit is not asked again: the run waits for the developer's next push (otherwise the 10-minute refresh would reopen the approval for the same commit).
- The refresh replays the pull request through the task sync as its webhook would have, instead of only updating the row: the sync acts once per change of state, so updating the row alone would have stopped the later webhook from completing the task. After its own merge the hub replays the merged pull request, so the fix task completes at once without waiting for GitHub.
- No database commit inside the merge (it can run inside the sync's savepoints); a merge the hub failed to record is recorded again by the next refresh or webhook.
- One pull request per fix: another that closes the same task waits until the first is closed.
- The card's checks update on every finished workflow; GitHub still settling the merge state (`unknown`, `unstable`) is a quiet wait; lasting blocks are told in plain words (conflicts, branch behind, a required review).
- Sensitive approvals and 24-hour waits reach the team's channel once, through the existing escalation post.
- Copilot follows pull requests only while the GitHub sync is on (Settings → GitHub); switched off, the refresh says so.
- Reject goes back to Preparing Fix with the reason on the task and the pull request (no separate follow-up run until the worker opens pull requests in 1c-2).

**Tests (tbo.localhost, module by module, `hold_commits`):** new `test_copilot_fix_flow` (30), `test_copilot_approvals` (7), `test_copilot_risk` (4), `test_copilot_github` (5), all pass; the affected modules pass unchanged: 12 Copilot modules, `test_github_sync`, `test_github_settings`, `test_merge_bot`, `test_complete_task`, `test_task_from_ticket_pause`, `test_task_moves`, `test_task_activity` (216 tests). Lint: black, isort, strict flake8, prettier and Frappe's semgrep rules clean on the changed files. Leftovers after the batches (Error Logs, which survive a rollback, and "Deleted Email Account" comments) were deleted by name; counts back to the baseline. Fix tests stub the AI task estimate (a fix task has no due date, so it would call the real model).

**Not yet done: the live demo on the sandbox repository.** Blockers found: tbo.localhost has no GitHub token; the GitHub sync is switched off there; tbocloud's GitHub Actions billing stops CI on private repositories, so the sandbox's check run fails and the hub (correctly) refuses to merge; no approvers are set. The demo's fix commit is ready on a local branch of the sandbox clone.
