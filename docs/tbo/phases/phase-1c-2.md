# Phase 1c-2: Copilot writes and tests the fix

**Status:** approved by the owner 13 Oct 2026 (pilot server m7g.xlarge; Copilot fixes only when asked; an engineer loads the weekly backup until a Copilot Press login exists). **The Mac-buildable part is built and tested (13 Oct, local, not pushed):** the evaluation fixes, H10 and W4 against a fake sandbox runner (see As built). W0 (the server) and W3 (the real sandbox runner, images, cleaning) wait for the server and the GitHub App. **W0's Terraform is written** (13 Oct) in TBO's private infrastructure repository, on a local branch, off by default, not applied. The operator applies it once the senior agrees to a new instance (operator action 29 there). **Estimate:** about 13 developer-days (the outline in `phase-1c.md` said 11; the GitHub App on the hub and the customer-copy path add two), in four parts: W0 (the server), W3 (sandbox sites), W4 (the fix stage in the worker) and H10 (helpdesk). **Design reference:** `../system-design.md` §5.3 (worker, sandbox, GitHub), §5.5 (models); `phase-1c.md` (1c-1 as built); `phase-1d.md` (the approval and merge it hands over to). **Built on:** helpdesk `tbo-copilot` (Phase 1d, local); the worker `apps/tbo-worker` (a pull request).

## Goal

When Copilot finds a bug, it fixes it itself:
1. It builds a throwaway copy of the customer's site and shows the bug there with a small test that fails.
2. It changes the code until that test passes, and checks that nothing else broke.
3. It opens the pull request with the results.

From there Phase 1d takes over: one person approves on the ticket, and TBO Support merges. Nothing reaches a live site in this phase.

## What exists today, and what it means for this phase

| Found (13 Oct) | Consequence |
|---|---|
| The worker (1c-1) investigates read-only on the Mac. Its lease ends with the diagnosis, and it does not stop the model after the hub accepts the report: in the evaluation one case kept retrying an "out of credit" error for 27 minutes | The fix needs a second job on the same run. Two worker fixes come first: stop as soon as the report is accepted, and treat credit and quota errors as final |
| Runs can only be claimed from Queued; the lease exists only while Investigating | Fix jobs need their own claim, and a lease while the run is at Preparing Fix |
| Phase 1d follows any pull request that says `Closes TASK-…`, holds it, asks one approval and merges | Copilot's pull request needs nothing new to be approved and merged; only the card gains the test results |
| The approval rule "the fix's developer never approves" takes the fix task's assignees as the authors | When Copilot wrote every commit, the customer's developer becomes the natural reviewer; the rule must look at who wrote the commits |
| The hub's GitHub access is one personal token. Fine-grained tokens cannot read check runs on private repositories and cover one organisation; owners must approve them | A GitHub App (one install per organisation, short keys per repository, reads checks) is needed, for the hub and for the worker's push |
| The connector reports every app on a site with its commit and branch (`get_code_identity`) | The site card can list everything a copy needs (Frappe, ERPNext, HRMS, the custom apps), not only the custom apps |
| The site card has `press_site` and `press_release_group`, still empty; no Press login exists | Automatic backups wait for a Press login; until then an engineer copies the backup to the server |
| tbocloud's Actions billing stops CI on private repositories | The sandbox's own checks become the main evidence; GitHub checks are shown when they run |
| The Mac has 8 GB of memory and under 4 GB of free disk | All of this runs on the server; the Mac keeps investigating if wanted |

## Decisions in this plan (please confirm)

| # | The design said | This plan | Why |
|---|---|---|---|
| 1 | A new "code" run for each fix | **The same run continues.** At Preparing Fix a fix job is queued on it; the worker claims it with a lease, as for the investigation. Copilot fixes only when **"Copilot writes fixes"** is on in the settings (off by default) or an agent presses **Let Copilot fix it** on the card | One timeline per ticket; the 1d approval flow is unchanged; nothing is attempted without being switched on |
| 2 | m7g.2xlarge (8 CPUs, 32 GB, 300 GB), 3 copies at once | **m7g.xlarge (4 CPUs, 16 GB, 200 GB disk), one copy at a time**, about $110 a month in Press's AWS region (checked 13 Oct 2026: $0.1166 an hour, 200 GB gp3 $18, system disk $3, public IP $4), about $81 with a 1-year reservation, about $50 for office hours only. The first estimate ($135) used US prices | Enough for a pilot with a few fixes a week; resized in minutes later |
| 3 | The engine inside the bench container, kept apart by a separate Unix user | **The AI runs in its own container** that sees only the run's folder, has no shell and no Docker. **A small sandbox runner on the server** builds the copies and runs a fixed list of commands for it. **Sandbox sites have no internet** | Kernel-level separation without rebuilding the engine; the AI can only call the runner's fixed operations |
| 4 | Press's own images from its registry | Images **built on the server from the official Frappe Docker recipe**, one per set of apps and versions, kept and reused | Press's registry needs extra GitHub access; the recipe is public and gives the same versions |
| 5 | The hub asks Press for a backup | **Weekly copy per customer.** Automatic through Press once a Copilot Press login exists. Until then an engineer downloads the database backup from Press and loads it with one command on the server | Copilot can start without the Press login |
| 6 | A LiteLLM proxy with per-run virtual keys and budgets | **LiteLLM only for routing and the fallback** (Kimi first, OpenAI when Kimi fails or runs out), without its database. Budgets stay in the worker, as built in 1c-1 | One container less (no Postgres); the budget code already exists |
| 7 | A separate private repository for the worker | **The public fork**, as in 1c-1: `apps/tbo-worker` (the fix stage) and a new `apps/tbo-sandbox` (runner, images, cleaning script). No customer data or server settings in it; those stay on the server | The worker needs the engine's packages; nothing in it is secret |
| 8 | GitHub App on both organisations | **The same**, and it also replaces the hub's personal token. The hub holds the App's private key. For each fix it gives the worker a key for **one repository, valid one hour**. The worker pushes only branches named `copilot/…` | No personal token in the pipeline; checks are readable; access is per repository |
| 9 | Self-approval blocked for the person who took over | **Who wrote the commits decides.** If every commit is Copilot's, the customer's developer may approve. If a person added commits, they cannot approve it (the 1d rule) | The developer is the best reviewer of a fix they did not write |
| 10 | (not in the design) | Demo pull requests on real customer repositories go to a **throwaway branch** made from the commit the customer runs, never to the customer's own branch | No customer code changes during the demo |

## What you will see at the end (the demo)

1. **The rehearsal.** The practice repository becomes a small installable Frappe app with the same planted bug.
   - A ticket goes to Copilot; it diagnoses the bug.
   - **Let Copilot fix it.** The server builds a sandbox site (ERPNext plus the practice app, no customer data). Copilot writes a test that **fails**, changes the code, and the test **passes**. It also checks that the site still migrates and shows no new errors.
   - Copilot opens the pull request "TASK-…: …", with the results table and `Closes TASK-…`.
   - The approval card shows **"Tested on a sandbox site"**, with each check passed or failed. Approve, and TBO Support merges, as in Phase 1d.
2. **On a copy of the pilot customer's site.**
   - A bug is planted on a throwaway branch of a customer app, made from the commit the pilot customer runs. A ticket describes the symptom.
   - The copy is built from the pilot customer's backup, cleaned first:
     - **removed:** passwords, keys and logins;
     - **hidden:** emails and phone numbers;
     - **switched off:** email sending and scheduled jobs.
   - Copilot reproduces the bug on the copy, fixes it and opens the pull request into the throwaway branch. The card says "Tested on a copy of the pilot customer's site".
3. **Safety.** It is shown that:
   - the cleaning report finds no password, key, token or email left in the copy;
   - the copy cannot reach the internet;
   - the AI cannot edit outside the app, run a shell or reach Docker;
   - the push key works for one repository and expires after an hour;
   - an instruction planted in the ticket text changes nothing.
4. **When Copilot cannot fix it.** After three attempts without a passing test, the run goes back to the developer. The fix task gets what Copilot tried and why it stopped. Nothing is pushed.
5. **Measured:** minutes and cost per fix, on the rehearsal and on the pilot customer copy.

## What changes, part by part

### W0 (the server): set up once (≈ 2.5 days)

| Item | Detail |
|---|---|
| Server | AWS Graviton m7g.xlarge, Ubuntu 22.04 arm64 (the AMI TBO's infrastructure pins; 24.04 only if the operator pins one), in the same region as Press. **One 200 GB root disk and no separate data disk**, a hard rule of TBO's infrastructure repo. The sandbox copies live in a 100 GB XFS image file on that disk, so copies are still made by reflink in seconds. Its own subnet and firewall group, trusted by nothing. Inbound: SSH from TBO's addresses only. Outbound: HTTPS, plus HTTP for Ubuntu's package mirrors. **Terraform written, option C approved 14 Oct** (TBO's private infrastructure repository a branch): a `t4g.medium` worker always on (30 GB, EIP, one role: start the fix server) plus an `m7g.xlarge` fix server (120 GB) that runs only for fixes and powers itself off after 20 idle minutes; 19 resources, about $39–46 a month; behind `enable_copilot_worker` (default off); `scripts/copilot-worker/setup.sh worker|sandbox`; `docs/copilot-worker.md` (the cost plan is private) |
| Containers | **litellm** (holds the Moonshot and OpenAI keys; Kimi → OpenAI fallback); **tbo-worker** (the engine and the job loop, as a non-root user, with only `/srv/tbo/runs` mounted; no Docker socket); per fix, a **sandbox stack** (MariaDB, Redis, the bench) on a network with no internet |
| Sandbox runner | A small service on the server (not in the AI's container) with Docker access. It answers a fixed list of operations over a local socket: build the image for a set of apps, prepare a customer copy, start a copy for a run, migrate, run a check, run the app's tests, list new error signatures, stop and delete. It refuses anything else |
| Engine build | host-core and the worker built for Linux arm64 on the server; the 1c-1 bundle script fixed (it copied one sidecar file, but the sidecar is now several) |
| Runbook | `docs/tbo/worker-server.md`: create the server, install, update, rotate keys, read logs, stop |

### W3 (tbo-copilot fork, `apps/tbo-sandbox`): sandbox sites (≈ 4 days)

| Item | Detail |
|---|---|
| Images | One image per set of apps at their commits (Frappe, ERPNext, HRMS and the customer apps, read from the site card), built with the official Frappe Docker recipe, kept until a version changes. Built once and reused |
| Customer copy | The database backup (no files) is restored into a quarantined stack, **cleaned** (below), checked, and kept as that customer's clean snapshot for at most 7 days. Each fix gets its own reflink copy of the snapshot, deleted when the fix ends; a failed attempt keeps its results 24 hours |
| Cleaning (`clean_site.py`) | **Removed:** user passwords and API keys; email account logins; OAuth and social login keys; integration and webhook secrets; payment, SMS and storage settings; ZATCA settings and certificates; secrets in `site_config.json` (a new encryption key). **Hidden:** customers', suppliers' and contacts' emails and phone numbers. **Switched off:** email sending, scheduled jobs, webhooks. **Dropped:** error, activity and access logs and the email queue. The list is reviewed with the helpdesk maintainer before the first real copy. A report lists what was changed, and a check fails the copy if any secret-shaped value remains |
| Rehearsal app | The practice repository becomes a minimal installable Frappe app (`demo_app`, the margin bug in a Sales Invoice hook); its sandbox is a fresh ERPNext site with no customer data |
| Checks the runner can do | Migrate; run one check script on the copy (the AI's reproduction); run the app's own tests (or named modules); load the pages and reports the ticket is about; list error signatures that are new since the check began |

### W4 (tbo-copilot fork, `apps/tbo-worker`): the fix stage (≈ 3.5 days)

| Item | Detail |
|---|---|
| First, from the evaluation | Stop the session as soon as the hub accepts the report; treat "insufficient balance" and quota answers as final (no retries); token prices set so every run reports its cost |
| Fix job | Claim kind `fix`. The app is cloned **writable** on a new branch from the commit the site runs; the other apps stay read-only; the runner starts the copy |
| The AI's tools | Read, Glob, Grep, **Edit and Write inside the app clone only**; `repo_git` (log, show, blame, diff); `sandbox_check` (run its reproduction script on the copy, before or after the change); `sandbox_tests`; `sandbox_migrate`; the hub tools. No shell, no other paths, no network tools |
| The order | 1. Write a reproduction check and see it **fail** on the unchanged code (else stop: the bug is not reproduced). 2. Change the code. 3. See the check **pass**, migrate pass and the app's tests pass. At most three rounds. 4. A second, fresh AI session reviews the change once; its findings are fixed or listed |
| The evidence | Produced by the worker from the runner's results, never from the AI's words: each check passed, failed or not run, and why; a secret scan of the change; the changed files and lines |
| Push and pull request | With the one-repository, one-hour key from the hub. Commits by "TBO Copilot". Title `TASK-…: <the fix>`. Body: summary, root cause, the change, the evidence table, risk, what a person should check, `Closes TASK-…`. Labels `copilot` and `no-auto-merge` |
| Report | `submit_change` to the hub (the pull request, its head commit, the evidence); on failure, `submit_result` with what was tried |
| Tests | `vitest` with a fake runner and a stub hub: the order (no fix without a failing reproduction), the tool limits, the push only to `copilot/…`, the report, the failure path |

### H10 (helpdesk `tbo-copilot`): fix jobs and the GitHub App (≈ 3 days)

| Item | Detail |
|---|---|
| GitHub App | HD GitHub Settings gains the App's id and private key. `copilot/github.py` uses an installation key for each repository when the App is set (merges, labels, checks), else the personal token as now. `repo_token(run)` makes the worker's key: one repository, Contents and Pull requests write, one hour |
| Fix jobs | Setting **Copilot writes fixes** (off). Card button **Let Copilot fix it** (agents, at Preparing Fix). `claim_job(kind="fix")` hands out Preparing Fix runs with a fix requested, no open pull request and attempts left (at most 2), with a lease; a lost lease puts the fix back in the queue |
| Worker API and tools | `repo_token` (only for the run's own repository, with a valid lease); MCP `submit_change`; the run context gains the site's full app list and the copy to use |
| On the card | "Copilot made this fix", and the results table **for the commit it was tested on**. If someone pushes after, the card says the results are for an older commit |
| Approval rule | The commit authors decide (decision 9) |
| Small fixes from 1d | The pull request must target the branch the customer's site runs, else the card warns and the hub does not merge. If GitHub refuses the merge method, the hub tries the next one. The fix task lists files cleanly. The conversation sync logs a failing customer site once an hour, not every 5 minutes |
| Site card | **Refresh from the site** reads every app, commit and branch through the connector (`get_code_identity`) |
| Press (when the login exists) | `press.py`: ask for a database backup of the site and pass its download link to the runner; the API shapes are checked on TBO's Press first |
| Tests | `test_copilot_fix_jobs.py` (claim, lease, attempts, `repo_token` limits, `submit_change`, the card's results, the authors rule); the 1d modules still pass |

## Out of scope (later)

Deploying through Press and checking the live site (Phase 2); configuration and data corrections (Phase 3); several copies at once; repositories in organisations without the App installed (those stay "investigate, then a person fixes"); attachments in the copies.

## How it is built and tested

- **Fork:** a worktree per task from `tbo`, pull request into `tbo` (never `main`), tests with `vitest`.
- **helpdesk:** H10 on `tbo-copilot`; module tests only on tbo.localhost with `hold_commits`; leftovers checked after each batch.
- **Server:** everything starts from the runbook. Keys live only in the server's environment files: model keys only in the litellm container; the App's private key only on the hub.
- **Order:**
  1. the two worker fixes from the evaluation;
  2. W0;
  3. W3 with the rehearsal app;
  4. W4 against the rehearsal;
  5. H10;
  6. the pilot customer copy, after the cleaning list is reviewed and you confirm the data use.

## Checkpoint (demo)

1. The rehearsal fix: a failing check before, passing after, the pull request with the results, the card, approve and merge.
2. The pilot customer copy: cleaning report clean; the fix reproduced and made on the copy; the pull request into a throwaway branch.
3. The safety items of the demo, shown in the run's events.
4. The failure path: a bug Copilot cannot reproduce goes back to the developer with what it tried.
5. Time and cost per fix recorded.

## Risks

- **Secrets in a copy.** A setting the cleaner does not know about could keep a key. Mitigation:
  - the list is reviewed with the helpdesk maintainer;
  - a secret-shape scan fails the copy;
  - copies have no internet and no files, and expire within 7 days.
- **Copies that will not build.** A customer app may not install at its deployed commit (missing dependencies, build steps). The run then stays "investigate, then a person fixes", and the reason is on the card.
- **Size and time.** Restoring a large database takes time and disk. That is why there is one clean snapshot per customer per week, and reflink copies per fix.
- **Fix quality.** The AI may write a fix that passes its own check but is wrong. Mitigations:
  - the check must fail before the change;
  - a second AI review runs;
  - the one approval still decides.
- **Cost.** A fix uses more model calls than a diagnosis; each run has a dollar cap (suggested $3) and the cost is shown.
- **Data to the AI provider.** Code and small samples from the cleaned copy go to Moonshot (or OpenAI on fallback). Their data terms must be recorded first (already an open item).
- **One server.** If it is down, fixes wait; leases put them back in the queue.
- **The App needs organisation owners**, and customer repositories in other organisations stay outside until they install it.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| The server (m7g.xlarge, Ubuntu 22.04 arm64, one 200 GB disk, in Press's AWS region) and an SSH key of mine added; a budget alert on the AWS account. **The Terraform is ready** (in TBO's private infrastructure repository). The senior agrees to a new instance; the operator approves installing Docker on it (their rules forbid packages unless an exception is approved), picks the SSH addresses and applies (operator action 29) | W0 | first |
| The GitHub App "TBO Copilot", created by an owner of teambackoffice and tbocloud, installed on both. Permissions: Contents and Pull requests read and write; Checks, Commit statuses, Actions and Metadata read. Its private key goes to the hub | W4, H10 | before W4 |
| The Moonshot account topped up; an OpenAI key | W0 | first |
| the helpdesk maintainer's review of the cleaning list | W3 | before the pilot customer copy |
| Your confirmation that a cleaned copy of the pilot customer's database may be used on the server, and the AI providers' data terms recorded | W3 | before the pilot customer copy |
| A Copilot Press login (optional now), or an engineer who loads the pilot customer's backup once with the runbook's command | W3 | before the pilot customer copy |
| The dollar cap per fix (suggested $3) | W4 | any time |

## As built so far (13 Oct 2026, local commits, nothing pushed)

**The worker (tbo-copilot fork, a branch from `tbo` after a pull request merged; the merged worktree was reused for disk space):**
- **engine (core change, listed in `docs/tbo/README.md`):** a 429 saying the account is out of credit or quota is no longer retried (it was retried for 27 minutes in the evaluation).
- the worker stops the model as soon as the hub has the report.
- **foundations:**
  - session profiles (tools and prompt per session);
  - a per-session permission decider (`editsInside`: Edit, Write and MultiEdit inside the fixed app only; not `.git`, not through a symbolic link, not by a delegate);
  - the workspace's writable clone on a `copilot/…` branch;
  - the sandbox runner client (`sandbox.ts`, one JSON request per line over a local socket, fixed operations);
  - the hub's `repo_token`;
  - fix limits.
- **fix jobs** (`fix.ts`, `fix-tools.ts`, `fix-prompt.ts`, `github.ts`):
  - choose the app; the push key; the clone; the sandbox copy; the fix session (sandbox, my_changes, repo_git, fix_done);
  - the worker's own checks: the test fails on the site's code and passes on the fix, migrate, the app's tests, no new errors, no secrets; a test that passes on the unchanged code ends the job;
  - a fresh review session (must-fix sends it back, at most 3 rounds);
  - commit, push, pull request (`Closes TASK-…`, results table, review notes, labels `copilot` and `no-auto-merge`), `submit_change`.
- 80 worker tests pass, including two end to end with the real engine, a scripted model, a fake sandbox that judges the code, a fake GitHub and a local repository.
- The worker's settings now carry the Kimi prices (0.95 / 4.00 / 0.16 per million tokens).

**TBO Support (helpdesk `tbo-copilot`):**
- rules for fixes:
  - a fix must target the branch the customer's site runs (evaluation and demo runs exempt);
  - the merge falls back to a method the repository allows;
  - the fix task lists files in words;
  - "Conversation sync failed" is logged once an hour.
- **the GitHub App:** `copilot/github_app.py` (keys per repository: the hub's kept, the worker's push key fresh and limited); the search per owner; the settings and run fields.
- the reminder tests ignore real approvals on the site.
- **fix jobs:**
  - the setting "Copilot writes fixes" and the dialog's "Let Copilot fix it";
  - the claim kind `fix` with a lease at Preparing Fix; `repo_token`; the MCP tool `submit_change`;
  - failures and lost workers hand the fix to the developer;
  - the card's "Tested by Copilot" table;
  - a pull request the App made alone may be approved by the customer's developer.
- the site card's **Refresh from the site** (every app, branch and commit through the connector).
- New tests: `test_copilot_github_app` (7), `test_copilot_fix_jobs` (9); `test_copilot_fix_flow` (34), `test_site_registry` (7) and the affected modules pass. Test leftovers deleted after each batch.

**Not built yet:**
- W0, the server;
- W3, the sandbox runner service, images, the customer copy and `clean_site.py`; it implements the protocol in `apps/tbo-worker/src/sandbox.ts`;
- the Press backup request (waits for the Press login; an engineer loads backups meanwhile).

The local demo of Phase 1d is set up (a ticket and a pull request on TBO's sandbox repository) and waits for a tbocloud owner to approve the GitHub token.

## W0 and W3 built, and the rehearsal checkpoint passed (16–17 Oct 2026)

**W0 (servers), option C:**
- Applied 16 Oct: the worker (t4g.medium, an Elastic IP) and the fix server (m7g.xlarge, a private address), 20
  resources. The pre-apply review added the worker's SSH out to the fix server and the clock fix.
- The worker program runs in Docker on the worker (a pull request).

**W3, the sandbox (a pull request, merged 17 Oct):**
- **Pieces:** `apps/tbo-sandbox` (runner on the fix server, as a forced SSH command; relay on the worker).
- **Images:** the official `frappe/erpnext:v15.122.0` image plus the customer's apps.
- **Sandboxes:** a fresh-site snapshot (about 2 minutes), then a reflink copy per fix, on an internal network.
- **Fix server:** the relay starts it with the worker's one permission.
- **Review:** CodeRabbit's 7 findings fixed (clone confinement, stale wake-ups, an honest cache, code in the cache
  key, test results, the dry-run rollback, a one-line key). 21 unit tests.

**The rehearsal (one of the demo scenarios), on a fresh site with the customer's apps:**
- **Diagnosis:** a bug, 0.99, the exact line, about 1 minute, $0.005.
- **The fix, about 4 minutes after "Let Copilot fix it":**
  - Copilot's test failed on the site's code (an assertion), then passed after a one-character fix;
  - migrate, the app's 9 tests, no new errors and no secrets all passed;
  - a second session reviewed it;
  - it opened its own pull request in the demo app's repository, with the evidence table.
- **Approval and deploy:** approved by the senior, merged by the GitHub App, deployed by Press (demo-alpha Success).
- **A false alarm afterwards:** the check after the deploy re-opened a field that the evidence cited as a
  customization, so the run was escalated. Fixed in helpdesk: only
  data and setting evidence names records. The demo hub needs a redeploy for it.

**Fixed on the way:**
- `TBO_MODEL_API_STYLE=responses` for gpt-5.6-luna;
- Press's real `deploy_information` fields (helpdesk);
- `apps.txt` without a final newline;
- MariaDB's first start;
- the production image lacking `xmlrunner`;
- `bench execute` running only installed-app code.

**Left for 1c-2:**
- **Copies of a customer's own data:** the cleaning script and its list (to review with the helpdesk maintainer first), and the Press
  backup path;
- **GitHub read keys:** a read-only App key for investigations of private repositories;
- **Prune:** removing old images.
