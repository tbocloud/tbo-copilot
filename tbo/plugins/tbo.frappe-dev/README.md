# TBO Frappe Dev (`tbo.frappe-dev`)

Builds Frappe and ERPNext features from a TBO Support task the way TBO does: a branch named after the task, TBO's
Frappe conventions, module tests on your own bench, the linters your repository's CI runs, and a pull request that
moves the task to Pending Review in TBO Support.

Design and use: [`docs/tbo/frappe-dev.md`](../../../docs/tbo/frappe-dev.md).

## Use it

1. Set up once: `gh auth login`, uv, a local bench with the app on a dev site (`allow_tests` on), and the plugin's
   settings (Frappe bench folder, Test site, Reviewers). Sign in to TBO Support in the TBO Support plugin.
2. Open the app's folder and type `/tbo.frappe-dev/start-task TASK-2026-00021`.
3. When it is done, `/tbo.frappe-dev/open-pr`. The app asks before it pushes.

## Contents

- `main.js`: registers the two tools.
- `lib/dev.js`: the tools `tbo_dev` (status, start_work, check, run_tests, job_status) and `tbo_dev_pr` (open_pr).
- `lib/git.js`: the repository, branch names, the branches never pushed to.
- `lib/lint.js`: what CI runs, run here (pre-commit, Semgrep, flake8/ruff, commit titles).
- `lib/tests.js`: the bench, the test site, the test modules of a change.
- `lib/pr.js`: the PR's title and body.
- `skills/`: Start work on a task, Open the pull request, TBO Frappe conventions, New Frappe app.

Tests: `node --test "tbo/plugins/tests/tbo.frappe-dev/*.test.js"` (real git repositories in a temporary folder; `gh`,
`uv` and `bench` are stand-ins).
