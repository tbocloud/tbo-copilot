# Frappe development from a task (`tbo.frappe-dev`)

**Status:** built for TBO Copilot Phase 20 (TASK-2026-00021). A bundled plugin, `tbo/plugins/tbo.frappe-dev/`, with
two agent tools and four skills. The task itself is read through the `tbo.support` plugin's `tbo_support` tool:
`my_tasks`, `get_task` and `start_task` come with TBO Support plugin **0.4.0**. With an earlier TBO Support plugin the
start-task skill asks the person for the task's subject, and the person starts the task's timer in TBO Support.

A developer builds a Frappe or ERPNext feature from a TBO Support task in the desktop app. Copilot starts a branch
named after the task, writes the code the way TBO writes Frappe code, runs the module's tests and the linters the
repository's CI runs, and opens the pull request. TBO Support moves the task to **Pending Review** by itself, through
its GitHub sync (`helpdesk/github_sync.py`).

## How it works

```
/start-task TASK-…  ──► tbo_support get_task ──► tbo_dev start_work ──► feature/TASK-…-short-name (from origin's base)
                        tbo_support start_task (timer on; TBO Support plugin 0.4.0)
code and tests      ──► conventional commits
                    ──► tbo_dev run_tests  (bench --site <test site> run-tests --module …, in the background)
                    ──► tbo_dev check      (pre-commit, Semgrep, commit titles: what CI runs, in the background)
/open-pr            ──► tbo_dev_pr open_pr ──► git push (fast-forward only) ──► gh pr create --draft ──► gh pr ready
                                                                   GitHub webhook ──► TBO Support: task → Pending Review
```

- **Two tools.** `tbo_dev` does everything that stays on the computer (`status`, `start_work`, `check`,
  `run_tests`, `job_status`); `status` and `job_status` are allowed in Plan mode. `tbo_dev_pr` (`open_pr`) is the one
  step that leaves the computer, so it is its own tool with risk `high`: the app asks before every push, even when
  `tbo_dev` was allowed for the session.
- **Long runs in the background.** A first pre-commit or Semgrep run downloads tools and can take minutes, more than
  the 110 seconds a tool call has. `check` and `run_tests` answer with a job; `job_status` gives its outcome.
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
   `<bench>/apps/`), **Test site** (empty: the bench's current site; never a live site), **Reviewers** (GitHub logins,
   optional), **bench command** and **uv location** if they are not on your PATH.
5. **TBO Support sign-in** in the `tbo.support` plugin, on the site that holds your tasks.

## Use it

1. Open the app's folder as the workspace. Type `/start` and pick **Start work on a task**, then the task number:
   `/tbo.frappe-dev/start-task TASK-2026-00021`. Copilot reads the task (or asks you for its subject, with a TBO
   Support plugin before 0.4.0), checks the setup, reads the repository's `AGENTS.md`, creates the branch, starts the
   task's timer (TBO Support plugin 0.4.0; otherwise you start it in TBO Support), writes the change and its tests,
   commits, and runs the tests and the checks until they pass.
2. Then `/tbo.frappe-dev/open-pr`. The app asks you to confirm the push. Copilot answers with the PR's link; within
   a minute the task shows **Pending Review** and the PR chip in TBO Support.

The skills **TBO Frappe conventions** and **New Frappe app, DocTypes, patches and tests** are loaded when the work
needs them.

## The tools

| Tool and action | What it does |
|---|---|
| `tbo_dev status` | The repository, its GitHub name, branch and task, its base, uncommitted files; `gh` and its login, `uv`, the bench and the test site |
| `tbo_dev start_work` | `task`, `subject` (`get_task`'s `branch_subject`), `kind` (`feature` or `fix`), `base`: fetches the base, then creates `feature/TASK-…-short-name` from `<remote>/<base>` (no upstream until the push), or switches to the task's existing branch, local or on the remote. The remote is `origin`, else `upstream` (the name `bench get-app` gives it), else the only one. Refuses a dirty tree; never stashes. The base is remembered in the branch's git config |
| `tbo_dev check` | The linters CI runs, on the committed branch: see "The checks" |
| `tbo_dev run_tests` | The test modules the branch touched (a changed test file; `test_<name>.py` beside a changed file; a DocType's own test, also for a change to its JSON; `<app>/tests/test_<name>.py`) or the ones named in `modules`, at most 20, one `bench --site <site> run-tests --module …` each, on the bench that holds this checkout in its `apps/`. A module passes only when its tests ran to the end with `OK` (Frappe 15 can exit 0 with failures, or with testing off). Never the whole suite: CI runs that |
| `tbo_dev job_status` | A job's outcome, or the latest `check` or `run_tests` |
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
suite locally; write to a site's data. Each of these is refused by the tools, not only written in a skill.

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
