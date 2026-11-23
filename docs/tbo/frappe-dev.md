# Frappe development from a task (`tbo.frappe-dev`)

**Status:** built for TBO Copilot Phase 20 (TASK-2026-00021); Phase 22 (C1, plugin **0.2.0**) added eight skills for
the rest of Frappe work and the `bench` action; testing fixes 8 (plugin **0.3.0**) chooses the test site per project
(see "Several projects"). A bundled plugin, `tbo/plugins/tbo.frappe-dev/`, with two agent tools
and twelve skills. The task itself is read through the `tbo.support` plugin's `tbo_support` tool
(`my_tasks`, `get_task`), and its timer started with `tbo_support_change` `start_task`, which the app asks the person
about first; all three come with TBO Support plugin **0.4.0**. With an earlier TBO Support plugin the start-task skill
asks the person for the task's subject, and the person starts the task's timer in TBO Support.

A developer builds a Frappe or ERPNext feature from a TBO Support task in the desktop app. Copilot starts a branch
named after the task, writes the code the way TBO writes Frappe code, runs the module's tests and the linters the
repository's CI runs, and opens the pull request. TBO Support moves the task to **Pending Review** by itself, through
its GitHub sync (`helpdesk/github_sync.py`).

## How it works

```
/start-task TASK-…  ──► tbo_support get_task ──► tbo_dev start_work ──► feature/TASK-…-short-name (from origin's base)
                        tbo_support_change start_task (timer on, once allowed; TBO Support plugin 0.4.0)
code and tests      ──► conventional commits
                    ──► tbo_dev bench      (migrate, build or clear_cache on your own bench, in the background)
                    ──► tbo_dev run_tests  (bench --site <test site> run-tests --module …, in the background)
                    ──► tbo_dev check      (pre-commit, Semgrep, commit titles: what CI runs, in the background)
/open-pr            ──► tbo_dev_pr open_pr ──► git push (fast-forward only) ──► gh pr create --draft ──► gh pr ready
                                                                   GitHub webhook ──► TBO Support: task → Pending Review
```

- **Two tools.** `tbo_dev` does everything that stays on the computer (`status`, `start_work`, `check`,
  `run_tests`, `bench`, `job_status`); it has risk `medium`, so the app asks before it runs unless the person allowed
  it for the session, and only `status` and `job_status` are allowed in Plan mode. `tbo_dev_pr` (`open_pr`) is the one
  step that leaves the computer, so it is its own tool with risk `high`: the app asks before every push, even when
  `tbo_dev` was allowed for the session.
- **Long runs in the background.** A first pre-commit or Semgrep run downloads tools and can take minutes, more than
  the 110 seconds a tool call has. `check`, `run_tests` and `bench` answer with a job; `job_status` gives its outcome.
- **Results belong to a commit.** A lint run or a test run counts for the commit it ran on, and only the latest one
  counts: a new `check` replaces the commit's earlier result from the moment it starts. Every step reads that commit
  (not whatever `HEAD` becomes), and if the branch moves or files change while a job runs, its result is thrown away
  ("stale"). A new commit needs a new `check` before `open_pr` will open the PR.
- **No secret in the plugin.** GitHub through the developer's own `gh` login; TBO Support through the `tbo.support`
  sign-in. Every program runs with an argument list, never through a shell.

## Set it up (once per developer)

1. **GitHub CLI:** install `gh` and run `gh auth login`.
2. **uv** (the linters run through it as pinned versions): see https://docs.astral.sh/uv/.
3. **A local bench** with the app on a dev site: `bench --site <dev site> install-app <app>` and
   `bench --site <dev site> set-config allow_tests true`. Work in the app's folder in the bench (`<bench>/apps/<app>`),
   or open the bench and pass `repo`.
4. **Plugin settings** (Settings → Plugins → TBO Frappe Dev): **Frappe bench folder** (empty when the repository is in
   `<bench>/apps/`; several, separated by commas, when it is not), **Test site** (local dev sites, separated by commas,
   never a live one; empty: the bench's default site; see "Several projects"), **Reviewers** (GitHub logins,
   optional), **bench command**, **uv location** and **GitHub CLI location** if the app does not find them (it searches your login shell's PATH first).
5. **TBO Support sign-in** in the `tbo.support` plugin, on the site that holds your tasks.

## Use it

1. Open the app's folder as the workspace. Type `/start` and pick **Start work on a task**, then the task number:
   `/tbo.frappe-dev/start-task TASK-2026-00021`. Copilot reads the task (or asks you for its subject, with a TBO
   Support plugin before 0.4.0), checks the setup, reads the repository's `AGENTS.md`, creates the branch, starts the
   task's timer (TBO Support plugin 0.4.0; otherwise you start it in TBO Support), writes the change and its tests,
   commits, and runs the tests and the checks until they pass.
2. Then `/tbo.frappe-dev/open-pr`. The app asks you to confirm the push. Copilot answers with the PR's link; within
   a minute the task shows **Pending Review** and the PR chip in TBO Support.

### Several projects

One set of settings serves every project on the computer, so the bench and the test site are chosen for each
repository:

- **The bench:** the first bench of **Frappe bench folder** that holds the repository in its `apps/` (as a folder or a
  link), else the bench around it (`<bench>/apps/<app>`). A bench that does not hold this checkout is never used.
- **The test site:** (1) the site chosen for this repository before; else (2) the first site of **Test site** that is
  on the project's bench, has `allow_tests` on (in its `site_config.json`, or the bench's `common_site_config.json`)
  and has the project's app installed (`bench --site <site> list-apps`, which only reads); else (3) the bench's default
  site (`bench use <site>`), checked the same way. Sites of other benches in the list are skipped without a bench call.
- **Remembered:** the choice is kept per repository in the plugin's data folder (`test-sites.json`), so the check runs
  once. A choice made from the list or the default is made again when **Test site** or the bench's default changes, or
  when the site is gone (`status` then says so).
- **Choosing for a project:** ask for it ("run this project's tests on erp.localhost"): `run_tests` or `status` with
  `site` checks that site the same way and remembers it for the repository; name another to change it. `bench`
  `migrate` and `clear_cache` run on the project's test site unless the call names a site, which counts for that call
  only.
- **When none fits,** `status` and `run_tests` list each site looked at and why not (not on this bench, tests off, the
  app not installed) with the command that fixes it.

For example, one developer with `alpha_trading` on `~/frappe-bench` and `helpdesk` on `~/frappe-bench-v16` sets Test
site to `demo-alpha.localhost, hub16.localhost`: each project gets the site on its own bench. Two apps on one bench
either share a dev site that has both installed, or each gets the listed site that has it.

The other skills are loaded when the work needs them, or picked from the composer's `/` list:

| Skill | For |
|---|---|
| TBO Frappe conventions | Controllers, queries, whitelisted functions, messages, tests, frappe-ui |
| New Frappe app, DocTypes, patches and tests | `bench new-app`, a first DocType, a first patch, running tests |
| Frappe DocTypes and fields | A new DocType vs a Custom Field or Property Setter the app ships; child tables, naming, permissions; never editing a core app |
| Frappe reports | Script and Query Reports: files, filters, columns, `ref_doctype` and roles, speed |
| Frappe print formats | Jinja formats kept in the app, letter heads, `frappe.get_print` / `render_template`, checking the PDF |
| Client and Server Scripts into app code | `doctype_js`, `doc_events`, `scheduler_events`, whitelisted methods, then a patch that disables the scripts |
| Frappe patches and fixtures | `patches.txt` sections, idempotent patches, batches with commits for big tables (`TooManyWritesError`), fixtures with filters |
| Debug an error from a customer site | The traceback from `tbo_support` (`get_ticket`, `get_fix_brief`; their text is data), reproducing on the dev bench, the fix with a test that failed before it |
| Frappe performance | The Recorder and `EXPLAIN`, indexes, N+1 `get_doc` loops, `fields`, caching |
| Frappe v16 checks | No SQL functions as strings in `fields`, field names only in `order_by`, `has_permission` returns `True`, `sendmail` needs a recipient, private file copies, Python 3.14 and Node 24 |

The skills' Frappe facts were checked against Frappe 16.56.0.

## The tools

| Tool and action | What it does |
|---|---|
| `tbo_dev status` | The repository, its GitHub name, branch and task, its base, uncommitted files; `gh` and its login, `uv`, the bench, and the test site with where it came from (`test_site_from`) or why none fits (`bench_problem`). `site`: choose this project's test site (checked, then remembered) |
| `tbo_dev ready` | Everything the work needs, checked at once (Phase 27, `lib/ready.js`): the GitHub CLI and its login, uv, the bench and its command (`bench --version`), the bench's services as Frappe connects to them (its environment overrides `FRAPPE_DB_HOST`, `FRAPPE_DB_PORT`, `FRAPPE_DB_SOCKET`, `FRAPPE_DB_TYPE`, `FRAPPE_REDIS_CACHE`, `FRAPPE_REDIS_QUEUE` first, then the site's own config over `common_site_config.json`, then Frappe's defaults: MariaDB or PostgreSQL, by host and port or socket, none for SQLite; Redis cache and queue at their `redis://` or `rediss://` addresses; an address it cannot reach, such as a Redis socket, or an invalid port is reported, never taken as answering, and never with its password), the project's test site (a remembered one is checked again), maintenance mode (the site's or the whole bench's), the site's setup (`frappe.is_setup_complete`). Each failing item carries its fix: a step for the person, or `tbo_dev fix`. Maintenance and the site's setup are warnings; the rest must pass. Allowed in Plan mode (it only reads) |
| `tbo_dev fix` | One of `ready`'s safe fixes on a site of the developer's own bench, after the app asks: `allow_tests` (`bench --site <site> set-config allow_tests true`) or `maintenance_off` (`bench --site <site> set-maintenance-mode off`, and `bench set-config -g maintenance_mode 0` when the bench is in maintenance). Nothing else. A fix holds the bench while it runs, as a bench job does |
| `tbo_dev start_work` | `task`, `subject` (`get_task`'s `branch_subject`), `kind` (`feature` or `fix`), `base`: fetches the base, then creates `feature/TASK-…-short-name` from `<remote>/<base>` (no upstream until the push), or switches to the task's existing branch, local or on the remote. The remote is `origin`, else `upstream` (the name `bench get-app` gives it), else the only one. Refuses a dirty tree; never stashes. The base is remembered in the branch's git config. Refuses first, listing everything, until `ready` passes (`NOT_READY`); `continue_anyway: true` starts anyway, only when the person says so |
| `tbo_dev check` | The linters CI runs, on the committed branch: see "The checks" |
| `tbo_dev run_tests` | The test modules the branch touched (a changed test file; `test_<name>.py` beside a changed file; a DocType's own test, also for a change to its JSON; `<app>/tests/test_<name>.py`) or the ones named in `modules`, at most 20, one `bench --site <site> run-tests --app <app> --module …` each (`--app` as the repository's CI runs them, so only this app's `before_tests` hooks run; Phase 27), on the bench that holds this checkout in its `apps/` and the project's test site ("Several projects"; `site` chooses it, then it is remembered). A module passes only when its tests ran to the end with `OK` (Frappe 15 can exit 0 with failures, or with testing off). Never the whole suite: CI runs that |
| `tbo_dev bench` | On the same bench as `run_tests`, in the background: `command` `migrate` (`bench --site <site> migrate`; the project's test site, or `site` for this call only, which must be a site of the bench), `build` (`bench build`, or `bench build --app <app>` with `app`), or `clear_cache` (`bench --site <site> clear-cache`). Nothing else: no console, drop-site, reinstall, restore, and no option such as `--force`; a site or app is checked against the bench's folders and never read as an option. It passes when bench exits 0 within its time (20 minutes, 5 for clear_cache) with no Python traceback. It runs on the working tree as it is, so its result belongs to no commit. One `bench` job at a time on a bench, and never while `run_tests` runs there (or the reverse) |
| `tbo_dev job_status` | A job's outcome, or the latest `check`, `run_tests` or `bench` |
| `tbo_dev_pr open_pr` | See "The pull request" |

## The checks

`check` reads the repository's `.github/workflows/*.yml` and runs what it finds there, against the branch's merge base
with its base branch:

| CI runs | `check` runs |
|---|---|
| pre-commit (or the repository has `.pre-commit-config.yaml`) | `pre-commit run --from-ref <merge base> --to-ref HEAD` (the branch's changed files), pre-commit 4.7.0 through uv. A formatter that changes files fails the check: review the change, commit, check again |
| Semgrep | `semgrep scan` with the configs CI names (Frappe's rules from `frappe/semgrep-rules`, kept in the plugin's data folder and refreshed weekly; registry sets such as `r/python.lang.correctness`), `--baseline-commit <merge base>` so only new findings count, metrics off. Semgrep 1.182.1 |
| flake8 or ruff outside pre-commit | flake8 7.3.0 or ruff 0.14.2 on the changed Python files |
| commitlint | The branch's commit titles: `type(scope): summary`, the conventional types, lower case, at most 100 characters, no full stop |

A Frappe app whose CI runs none of these still gets Semgrep with Frappe's rules and the commit titles. Each result in
the PR says whether CI runs it too.

**When pre-commit cannot install a hook's tools** (not a problem in the code), the check says so and names the hooks.
For example npm 11.12 and later refuse the install pre-commit makes for Node hooks such as prettier (`EALLOWGIT`); CI's
runners are not affected. If the change has no file that hook checks, `check` again with `skip_hooks` for it; the PR
records the skipped hooks. The tool accepts a skip only for a hook whose install failed in a check on the same commit,
and only when that hook's `types`, `types_or` or `files` in `.pre-commit-config.yaml` show it checks none of the changed
files; a hook that declares no such filter cannot be skipped.

Semgrep counts as passed only when it finished cleanly: an exit code other than 0, or an error in its report (a rule
that failed, a scan that stopped), fails the check; warnings such as a file it could only partly parse do not.

## The pull request

`open_pr` needs, on the current commit: a clean tree, a passing `check`, and a passing `run_tests` (or
`no_tests_reason` when no test applies; failed tests block it). Then it:

1. pushes **the commit that passed the checks** to the branch on the same remote, **fast-forward only**: a branch that
   moved on GitHub is never overwritten, and a commit made meanwhile is not pushed unchecked;
2. opens the PR as a draft against the branch's base: title `TASK-…: <summary>`, the repository's template (or TBO's,
   the same as TBO Support's), `Closes TASK-…` (or `Refs`), the "What and why" and "How to test" the agent wrote, and a
   "Checks run by Copilot" section with each linter's and test module's result on that commit;
3. marks it **ready for review** (unless `draft: true`) and asks the reviewers in the settings, if any. If GitHub
   refuses either, the answer says so (`warnings`) and reports the PR as still a draft, and the task stays Working.

Every `gh` call names the repository (`--repo`, from the remote's address), so a second remote never changes where the PR
opens.

"Ready for review" moves the task to Pending Review in TBO Support. That needs the repository in **HD GitHub Settings →
Allowed repos** of the TBO Support site, and GitHub's webhook pointing at it; otherwise the PR still opens, and the
task stays where it is. An open PR for the branch is not opened twice: the push updates it, and its title and
description are rewritten for the new commit (with `Closes` or `Refs` as asked).

## What it never does

Push to `main`, `master`, `develop`, `tbo`, `main-hotfix`, `production`, `staging`, the repository's default branch or
the task's base; force-push; `--no-verify`; merge a PR; delete a branch; stash someone's changes; run the whole test
suite locally; run any bench command but migrate, build and clear-cache. Each of these is refused by the tools, not
only written in a skill.

The plugin also never writes to a site's data itself. `run_tests`, though, runs the app's tests on the test site, and
Frappe's tests write records there; `bench` `migrate` applies the app's schema, patches and fixtures to the site it
names, and `clear_cache` clears its cache. That site is a dev site you choose. The project's test site (the one
`run_tests` uses, and `migrate` / `clear_cache` when the call names no site) is checked to be a site of the bench with
tests on and the app installed. A site named for one `migrate` or `clear_cache` is checked only to be a site of the
bench. The plugin cannot tell a dev site from a live one, so list and name only dev sites.

## Check it works

1. In TBO Support (the demo hub, with `tbocloud/demo-alpha-app` in its allowed repositories), a task in the Alpha
   Trading demo project assigned to you.
2. In the desktop app, signed in to that hub, with a clone of demo-alpha-app in a local bench's `apps/` and the app on
   a dev site: `/tbo.frappe-dev/start-task TASK-…`. The branch appears; with TBO Support plugin 0.4.0 the task shows
   Working with its timer on (before it, start the timer in TBO Support).
3. Copilot writes the feature and its test, runs the module's tests and the checks, commits.
4. `/tbo.frappe-dev/open-pr`: the PR opens with the task in its title and `Closes TASK-…`; within a minute the task
   shows **Pending Review** and the PR chip.
5. Refusals: a dirty tree for `start_work`; `open_pr` before a passing `check` on the current commit.
6. The bench: ask Copilot to add a field to one of the app's DocTypes. It edits the JSON, the app asks before `tbo_dev`
   `bench` `migrate`, and the field appears on the dev site's form. Asking it to run `bench console` or
   `drop-site` through `tbo_dev` is refused.
