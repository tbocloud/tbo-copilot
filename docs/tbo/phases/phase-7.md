# Phase 7: CI, and one release path for every merge

**Status:** plan written 20 Oct 2026; **approved by the owner 24 Oct 2026**, with every recommended decision except decision 1: the owner said the customer repositories are public, so CI runs on GitHub's own runners at no cost and no payment method is added. A repository that is still private joins the pipeline once it is public (on 24 Oct, many repositories active since September were still private, among them customer apps). **Estimate:** about 12 developer-days:
CI1 (one CI for every Frappe app, ≈ 2.5), H23 (a release for every merge, ≈ 3), H24 (the CI gate, the approval and
the nightly train, ≈ 3), H25 (staging, undo and the release record, ≈ 2), W11 (the staging check on the sandbox,
≈ 1), and the checkpoint on the demo bench (≈ 0.5). **Design reference:** `expansion-plan.md` Phase 7 (approved 17
Oct, order 6 → 7 → 5). **Built on:** Phase 2 (Press deploys, the check after, undo by a revert pull request), Phase 1c-2
(the sandbox runner), Phase 6 (approval cards in Teams and the panel). **Followed by** Phase 8 (Copilot builds
approved customizations, approved 20 Oct).

## Goal

Every change to a customer's app reaches the customer's site the same way, whoever wrote it:

1. CI checks every pull request: lint, an install on a fresh bench, the app's tests.
2. A merge into the branch a customer site runs becomes a **release** in TBO Support.
3. The release is checked on staging. One person approves it. It deploys through Press in the night window, the site
   is checked after, and a failure is undone by a revert pull request.
4. Every release is recorded: what changed, who approved, which sites, and the checks.

Today only Copilot's fixes go this way. Everything else is deployed by hand from the Press dashboard.

## What exists today (checked 20 Oct)

| Found | Consequence |
|---|---|
| Both GitHub organisations are on the Free plan. Public repositories get unlimited Actions minutes; private ones get 2,000 minutes a month per organisation | CI on public repositories costs nothing |
| **tbocloud's private repositories:** every Actions job is refused with "recent account payments have failed or your spending limit needs to be increased" (solar_operations, growthx_core, Solar, medservice) | The billing blocker is in tbocloud only. teambackoffice's private repositories do run |
| **teambackoffice's private customer apps:** 17 have CI, and only 2 were green on their last run. The others fail for real reasons: tests, linters, the MariaDB client install, and more | A strict CI gate would block most of them. A repository joins the pipeline once its CI is green |
| The pilot customer's three repositories have the AI review only and no tests in CI | Onboarding adds the CI. It's free there |
| helpdesk, helpdesk_client, tbo-copilot and the demo apps: CI green | Already fine |
| Rulesets can't be enforced on private repositories on Free (GitHub answers "Upgrade to GitHub Pro or make this repository public") | GitHub can't require checks there. **The release gate in TBO Support becomes the enforcer:** nothing deploys without green CI |
| Some customer repositories change only through pull requests. Others mostly take direct pushes (one had 0 of its last 14 commits through a pull request) | Direct pushes need a path too: TBO Support sees them through Press |
| Press checks GitHub every 5 minutes and shows "Update available" per release group. A person deploys from the dashboard, choosing apps and sites. `tbo_press_guard` allows one build at a time | TBO Support can see every waiting update per release group (`deploy_information`, which Phase 2 already reads) |
| TBO Support: HDS Deploy Request needs a Copilot run. `deploy.py` deploys one app for one run, with the window, the lock, the check after, and undo by `revertPullRequest` | It is generalised: a release comes from a Copilot run, a pull request or a push |
| The merge bot (`tbocloud/ai-review`) merges pull requests in both organisations once CodeRabbit approves and the checks are green | Unchanged. The release starts after the merge |
| Press has UAT v15 and UAT v16 release groups. Site cards have an environment field (Production / UAT / Sandbox) | Staging means the customer's UAT site when their card has one |
| The TBO Copilot GitHub App is installed on the tbocloud demo repositories only | It must be installed on each pilot repository, to read checks and open revert pull requests |

## Decisions in this plan (approved 24 Oct 2026; decision 1 changed as above)

1. **CI minutes for private repositories:** GitHub's own runners everywhere. A tbocloud organisation owner adds a
   payment method and a spending limit, for example $20 a month. *(Recommended.)*
   - The price is about $0.006 a minute on Linux, according to third-party pricing pages; check GitHub's billing page.
   - A Frappe test job takes about 10 minutes, so the 2,000 free minutes cover about 200 runs a month per
     organisation. 100 more runs cost about $6.
   - The alternative is a self-hosted runner on the fix server, for private repositories only. It costs no minutes,
     but the fix server runs longer (about $0.15 an hour) and we maintain it. It must never serve public repositories,
     because a pull request from a fork could run code on it.
2. **The release gate:** TBO Support deploys a commit only when its CI is green. A senior can override it with a
   written reason, recorded on the release. *(Recommended.)*
3. **Direct pushes (no pull request)** are picked up from Press. They deploy only with a senior's approval and are
   listed in the weekly report. *(Recommended.)* The alternative is to refuse them.
4. **Deploys from the Press dashboard** stay possible during the pilot. The weekly report lists the ones that went
   around the pipeline. *(Recommended.)* Later, `tbo_press_guard` can refuse dashboard deploys for groups that are in
   the pipeline.
5. **Staging:** the customer's UAT site when their card has one. Otherwise, the sandbox check of the merged commit:
   a fresh site with the customer's apps, migrate, the tests, and no new errors. *(Recommended.)* A UAT site for every
   customer comes later.
6. **A nightly train:** approved releases for the same release group go out together, in one build per group per
   night. *(Recommended.)* This means fewer builds on the shared workload.
7. **Who approves:** anyone on the approver rota except the pull request's author, and a senior for sensitive changes
   (the same risk rules as Copilot's). *(Recommended.)*
8. **Rollout:**
   1. the demo apps;
   2. The pilot customer's apps;
   3. each other customer app, once its CI is green.

   TBO's own apps (helpdesk, helpdesk_client) come later. *(Recommended.)*

## What you will see at the end

A developer's pull request on the pilot customer's app, "Closes TASK-…":

1. **CI runs on the pull request:** lint, an install on a fresh bench, and the tests, plus the AI review and the task
   reference as today. The merge bot merges it after CodeRabbit's approval and the person's approval.
2. **TBO Support sees the merge** and creates a release, TBO-REL-…. It shows the commits, the pull request, the task
   and ticket, the sites that run that branch (from the site cards), and the CI result.
3. **Staging:** the sandbox check, or the pilot customer's UAT site when there is one. Its result goes on the release.
4. **The approval card,** on the ticket and the task, in Teams and in the panel, shows what changed, the CI result,
   the staging result and the sites. Someone other than the author approves.
5. **Tonight's train:** every approved release for that release group goes out in one Press deploy in the window.
   Each site is checked after. A linked ticket's customer hears "Fix live".
6. **On failure,** Press recovers the site, or the check after fails. Either way the release fails, a revert pull
   request opens on its own, and the author and the approver are told.
7. **Monday's email** lists the week's releases, how long approvals waited, failures and undos, and the bypasses
   (dashboard deploys and direct pushes).

## What changes, part by part

### CI1 (`tbocloud/ai-review` and onboarding): one CI for every Frappe app (≈ 2.5 days)

- A reusable workflow, `frappe-app-ci.yml`, that callers pin to `v1` like the AI review. It runs:
  - lint: pre-commit when the repository has a configuration, else ruff on the changed files;
  - an install on a fresh Frappe/ERPNext bench of the version the caller names, with MariaDB and Redis services;
  - the app's tests;
  - `bench build` when `public/` changed.

  The check name is fixed: `frappe-ci / tests`.
- A caller template. A person opens one onboarding pull request per pilot repository, because the GitHub App has no
  Workflows permission.
- For a repository whose CI is red today, the onboarding pull request lists the failures. The repository joins the
  pipeline when CI is green.
- A short page in the docs: "CI for Frappe apps".

### H23 (helpdesk): a release for every merge (≈ 3 days)

- HDS Deploy Request becomes the release:
  - `run` is no longer required;
  - new fields: `source` (Copilot run / Pull request / Push), `pull_request`, `repository`, `from_commit`,
    `to_commit`, `author`, `ci_status`;
  - new statuses: Waiting for CI, Staging, Waiting for approval.

  Copilot's deploy requests work as before, with source "Copilot run".
- **On a merge:** when the GitHub sync (webhook, or the App's 10-minute poll) reports a merged pull request into the
  branch a site card runs, TBO Support creates a release. It finds the Production sites from the site cards by
  repository and branch, and the task and ticket from "Closes TASK-…".
- **On a push:** a new hourly job reads Press's waiting updates (`deploy_information`) for each release group on
  the site cards. An update with no release becomes a release with source "Push", the commits listed, marked "no pull
  request".
- A release card on the ticket and the task, and a "Releases" report by customer, release group and status.

### H24 (helpdesk): the CI gate, the approval and the nightly train (≈ 3 days)

- **The gate:** TBO Support reads the head commit's check runs and statuses through the GitHub App (reusing
  `fixes.record_checks`).
  - Green: the release continues.
  - Red or missing: "Waiting for CI", and the author is told.
  - A senior's override needs a reason, which is kept on the release.
- **The approval:** HDS Copilot Approval gets the type "Release":
  - its payload hash covers the repository, the commits, the sites and the CI result;
  - the rota skips the author;
  - a senior approves when `risk.py` marks the release's diff sensitive;
  - the card is a variant of the Phase 6 fix card, in Teams and the panel.
- **The train:** `deploy.run_due` groups approved releases by release group into one Press deploy, with every app
  row and every release's sites. Phase 2's limits hold: ≤ 6 site rows and < 1,000 characters, otherwise sequential
  batches; the merged commit is pinned per app, and a mismatch is refused. Copilot's own releases join the same train.

### H25 (helpdesk): staging, undo and the release record (≈ 2 days)

- **Staging:**
  - When the customer has a UAT site card, the release deploys there first, at the start of the window, with the
    check after. Production follows after the approval, in the next window.
  - Without a UAT site, the release waits on the sandbox check (W11), which can run at any time.
- **Undo:** when the check after fails, a revert pull request opens through `revertPullRequest`, generalising
  `fixes.undo` to releases. It goes through the same pipeline, first in line. A push has nothing to revert, so the
  author and a senior are told instead.
- **The weekly report** (the Monday pilot email gains a section) lists the releases, the approval wait, failures,
  undos, and the bypasses. A bypass is a Press deploy with no release, found by comparing Press's deploys with the
  releases.
- Tests: `test_copilot_releases.py`, about 20.

### W11 (worker): the staging check on the sandbox (≈ 1 day)

- A new job kind, `release_check`. The worker starts a sandbox site with the site card's apps at their deployed
  commits plus the release's new commit. It runs migrate and the app's tests, and checks for no new errors. It
  reports the evidence the same way as for fixes.
- No AI model is used. This is the sandbox runner's fixed operations only.

## Out of scope (later)

- A self-hosted runner, unless decision 1 changes.
- A UAT site for every customer.
- Refusing dashboard deploys in `tbo_press_guard`.
- Production deploys without an approval (`auto_deploy_categories` stays as in Phase 2).
- Releases of TBO's own apps (helpdesk, helpdesk_client).
- GitHub Pro, for rulesets on private repositories.

## How it is built, run and tested

The same way as the earlier phases:

- helpdesk on the `tbo-copilot` branch, with module tests on the local site with `hold_commits`, one module at a time;
- the worker part as one pull request into `tbo`, never stacked;
- the reusable workflow as a pull request into `tbocloud/ai-review`, with the `v1` tag moved once it is merged;
- the checkpoint on the demo bench.

## Checkpoint (on the demo bench)

- **The main path,** on demo-alpha-app:
  1. A developer opens a pull request (not Copilot's) that says "Closes TASK-…".
  2. CI is green, and the pull request is merged.
  3. TBO Support shows a release with demo-alpha as its site.
  4. The sandbox check passes.
  5. Someone other than the author approves in Teams or the panel.
  6. Tonight's train, or Deploy now, deploys it, and the check after passes.
  7. The release is Succeeded, and the ticket is told.
- **The other cases:**
  - red CI: the release waits, and a senior's override is recorded;
  - a direct push to demo-beta-app's main branch: a release with source Push, which needs a senior;
  - two approved releases on the demo bench (Alpha and Beta): one Press deploy;
  - a check after that fails on purpose: a revert pull request opens on its own;
  - a deploy from the Press dashboard: listed in the weekly report as a bypass.

## Risks

| Risk | Mitigation |
|---|---|
| Most private customer repositories have red CI today, so the gate would block their deploys | Rollout per repository: a repository joins once its CI is green, and deploys as today until then |
| Developers resist an extra approval for their own merges | One click in Teams. The nightly train saves them the dashboard work. For urgent changes, a senior uses Deploy now |
| Releases pile up on one group into a big night build | Phase 2's batch limits. The train splits into sequential deploys |
| Press deploys a different commit than the release (another push landed in between) | The commit is pinned per app, as in Phase 2, and a mismatch is refused and re-approved |
| A shared bench moves other customers' sites | Phase 2's rule: when other customers share the group, a senior approves, and the card lists every site |
| CI minutes cost grows | The spending limit. Move private repositories to a self-hosted runner if the bill passes the limit |

## What TBO must provide

- **A tbocloud organisation owner:** a payment method and an Actions spending limit (decision 1).
- **The TBO Copilot GitHub App** installed on each pilot repository, starting with the pilot customer's three.
- **A person to merge the onboarding CI pull requests** (the App can't change workflows), and repository owners to
  make red CI green.
- **Which customers have UAT sites,** so their site cards can be added with the UAT environment.
- **To tell the developers** that, for repositories in the pipeline, merges deploy through TBO Support and not from
  the Press dashboard.

## As built (24 Oct 2026)

**Pushed:** helpdesk `tbo-copilot` (main merged in first; H23, H24, H25);
the worker W11 is a tbo-copilot pull request into `tbo`; CI1 is a branch of `tbocloud/ai-review`.
Tests: `test_copilot_releases.py` 44, and every Copilot module plus main's new ones pass on the local site, one
module at a time; worker 135 + 6 (end-to-end files run apart) and 7 new.

**How it differs from the plan, and why:**

- **Approvals live on the release itself** (assigned to, decided by and when, the hash of what the approver saw), not
  in HDS Copilot Approval: those records are tied to a Copilot run and its ticket everywhere (decide, reminders,
  cards), and most releases have neither. The release's card reuses the Phase 6 card in Teams and the panel; the
  desk form has the same buttons.
- **Releases keep the name TBO-DEP-…** (the deploy request is the release).
- **Pushes come from GitHub, not Press:** one watcher reads each deployed branch's tip every 10 minutes and sees
  merges and pushes alike; a commit without a merged pull request makes the release a Push (a senior decides).
- **CI is judged where it runs:** on each pull request's last commit (CI does not run on the merge commit), on a
  push's own commit, and on the branch tip when CI ran there. A commit without any check fails the gate.
- **Staging comes before the approval**, so the approver sees its result: the UAT site deploys in the next window
  (the release waits), else the worker's sandbox check runs at once. A check that could not run goes to the seniors,
  not the authors.
- **Automatic revert only after the check after failed** (the site ran the new code). When Press fails the update it
  puts the site back itself; a revert then would undo code that never went live, so people are told instead.
- **Bypasses** in the weekly email are Press builds on the pipeline's benches minus the deploys TBO Support asked
  for: an estimate, since Press does not say who started a build.
- **The ticket** gets notes (scheduled, live, failed) rather than a release card in its Copilot dialog.

**Still to do:**

1. CI1: the trial on a throwaway branch of demo-alpha-app passed (lint green; tests green, 9 tests; branch deleted).
   The pull request on `tbocloud/ai-review` was **closed without merging at the owner's request (24 Oct)** and its branch
   deleted; `main` and the `v1` tag never changed. The commit is kept locally. Until a shared CI exists, the release gate reads each repository's own checks
   (any check run or status on the commits), so a repository needs some CI of its own to release.
2. Onboarding pull requests that add CI: on hold with CI1; the pilot customer's three repositories only with the owner's OK
   (customer repositories).
3. The TBO Copilot GitHub App installed on each pilot repository (today the tbocloud demo repositories only).
4. The demo hub redeployed with helpdesk and the worker rebuilt from `tbo` after its pull request; then on the demo hub
   HDS Copilot Settings → Releases: on, the demo repositories listed.
5. The checkpoint on the demo bench.

## Checkpoint passed on the demo bench (28 Oct 2026)

- **demo-alpha.**
  - The release held: the CI fix; a revert pushed straight to main (its CI was red, so the gate waited); and the restoring pull request ("Closes TASK-…", CI green).
  - The sandbox check passed: migrate, the app's tests, and no new errors.
  - Administrator (a senior who wrote none of it) pressed **Deploy now** at 15:09.
  - The bench already ran the commit (DevOps had updated it from the dashboard), so the deploy went straight to the check after it. Result: **Succeeded at 15:16**.
  - Ticket 0101 was told twice: "deploys …" and "is live on the demo alpha site and checked".
- **demo-beta.**
  - The first sandbox check came back "not run": the hub sent the other apps' repositories as owner/name, and the runner needs GitHub addresses. Fixed.
  - Queued again, it passed.
  - Assigned to the developer, who approved in **Teams** (`decided_via: Teams`, Deploy now) at 15:26.
  - Press built the bench and updated the site (Success at 15:45). The check after it passed: **Succeeded at 15:50**.
- **Also fixed on the way:** a Press site's card had no app branch, so no release was ever made for it.
- **Not exercised:**
  - a check after the deploy that fails on purpose (an automatic revert pull request);
  - the weekly bypass count.

  Both are covered by `test_copilot_releases.py`.
- **Seen:** the demo hub has no outgoing email, so the email copies of notices failed. Teams and the panel carried them.

