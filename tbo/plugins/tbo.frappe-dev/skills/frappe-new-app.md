---
name: New Frappe app, DocTypes, patches and tests
description: Use when creating a Frappe app with bench new-app, adding a DocType, writing a patch, or setting up and running an app's tests on a local bench.
---

# New Frappe app, DocTypes, patches and tests

All of this runs on the developer's **local** bench and a dev site, never on a live site. Use the bench's own Frappe
version's way (`bench version`).

## A new app

1. `cd <bench> && bench new-app <app_name>` (snake_case). It asks for a title, description, publisher, email and
   licence, and whether to add a GitHub workflow for tests: say yes. Frappe 15 also adds `.pre-commit-config.yaml` and
   a lint workflow (pre-commit and Semgrep), which `tbo_dev` `check` runs.
2. `bench --site <dev site> install-app <app_name>`.
3. Put it on GitHub in the right organisation (tbocloud or teambackoffice) with `main` as the default branch; add
   `AGENTS.md` with the app's own rules. The first work goes through a task's branch and a PR like any other.

## A DocType

- Easiest: turn on developer mode (`bench --site <dev site> set-config developer_mode 1`), create it in the desk under
  the app's module, and the files appear in `<app>/<module>/doctype/<doctype>/`: the `.json`, the controller `.py`,
  the form `.js`, and `test_<doctype>.py`.
- By hand: copy the folder layout of an existing DocType in the app and edit the JSON in the same format and key order.
- `bench --site <dev site> migrate` applies it. Field names are snake_case; links point at existing DocTypes;
  permissions are set in the JSON's `permissions` table.

## A patch (a data change)

- A module `<app>/patches/v<n>/<what_it_does>.py` with `def execute():`, listed in `<app>/patches.txt`:
  - under `[pre_model_sync]` when it must run on the **old** schema (before the DocType JSON is applied);
  - under `[post_model_sync]` when it needs the **new** fields.
- It runs once per site (Frappe records it in Patch Log) and must be safe to run twice: check before you change.
- Try it on the dev site: `bench --site <dev site> migrate` (or `bench --site <dev site> execute
  <app>.patches.v1.<name>.execute` while writing it).

## Tests

- Once per dev site: `bench --site <dev site> set-config allow_tests true`.
- Test classes: Frappe 15 `FrappeTestCase` (`frappe.tests.utils`), Frappe 16 `IntegrationTestCase` (`frappe.tests`).
  Records made in a test are rolled back after it; helpers go in the app's `test_utils.py`.
- Run one module: `bench --site <dev site> run-tests --module <app>.<module>.doctype.<doctype>.test_<doctype>`
  (or `--doctype "<DocType Name>"`). In Copilot: `tbo_dev` `run_tests`. The whole app's suite runs in CI.

## Hooks worth knowing

`doc_events` (react to another app's DocType), `scheduler_events` (background jobs), `fixtures` (custom fields and
property setters shipped with the app), `override_whitelisted_methods` and `override_doctype_class` (use sparingly;
prefer `doc_events`).
