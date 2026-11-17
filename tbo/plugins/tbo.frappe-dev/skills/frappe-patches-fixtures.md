---
name: Frappe patches and fixtures
description: Use when a Frappe or ERPNext change must fix or move existing data on every site (a patch in patches.txt), or ship records with the app (fixtures): order, idempotence, big tables, testing on the dev bench.
---

# Frappe patches and fixtures

A schema change is a DocType's JSON. A change to the data that sites already have is a **patch**. Records the app
ships (Custom Fields, Property Setters, roles, settings) are **fixtures** or are made in code.

## A patch

1. A module `<app>/patches/v<major>_<minor>/<what_it_does>.py` (follow the folder names the app already uses) with:
   ```python
   import frappe


   def execute():
       ...
   ```
   A docstring on `execute` says what it does; migrate prints it.
2. One line in `<app>/patches.txt`, at the end of the right section:
   - `[pre_model_sync]`: runs on the **old** schema, before the DocType JSON is applied. For reading a column the new
     JSON removes or renames.
   - `[post_model_sync]`: runs after the new schema is in place. Most patches go here.
3. Frappe runs each line once per site and records it in **Patch Log**. A line that is already recorded never runs
   again: to run changed code, add a new line (a new module, or the same one with a `#2026-11-16` comment after it).

**Rules**
- **Idempotent.** Safe to run twice and on a site that never had the old data: check before you change
  (`if not frappe.db.has_column(...)`, `if frappe.db.exists(...)`).
- **Fast and set-based.** Update with one query where you can: `frappe.qb.update(...)`, `frappe.db.set_value` with
  filters, `frappe.db.bulk_update`. Not `frappe.get_doc(...).save()` for every row of a large table.
- **Big tables: commit in batches.** A patch runs in one transaction, and Frappe raises `TooManyWritesError` past its
  writes per transaction (200,000 by default, or `max_writes_per_transaction`). Walk the table in batches by `name`
  and call `frappe.db.commit()` after each batch, so a failure keeps the finished part and a re-run skips it. Frappe's
  Semgrep rule against manual commits does not apply to `patches/`.
  ```python
  def execute():
      last = ""
      while names := frappe.get_all("Sales Invoice", filters={"name": (">", last), "tier": ("is", "not set")},
                                    pluck="name", order_by="name asc", limit=5000):
          frappe.db.set_value("Sales Invoice", {"name": ("in", names)}, "tier", "Standard", update_modified=False)
          frappe.db.commit()
          last = names[-1]
  ```
- `update_modified=False` when the change is not a user's edit, so `modified` keeps its meaning.
- A field from a fixture (a Custom Field) is not there yet in a patch: migrate syncs fixtures after the patches.
  Create it in the patch with `create_custom_fields` before using it. `frappe.reload_doc(module, "doctype", name)`
  reloads only a DocType's own JSON: use it for a field defined in your DocType's JSON, never for a fixture's field.
- No `print` noise and no prompts. A patch that can fail on bad data says which record and why, then raises.

**Try it on the dev bench**
- While writing: `bench --site <dev site> execute <app>.patches.v1_0.<name>.execute` (runs it without recording it).
- Then for real: `tbo_dev` `bench` with `command: migrate`, and `job_status`. Run migrate a second time: nothing must
  change.
- A test can call `execute()` on records it made, and prove a second call changes nothing. `tbo_dev` `run_tests`.

## Fixtures

Records the app ships and that migrate writes on every site where the app is installed.

- In `hooks.py`, always with filters:
  ```python
  fixtures = [
      {"dt": "Custom Field", "filters": [["module", "=", "My App"]]},
      {"dt": "Property Setter", "filters": [["module", "=", "My App"]]},
      {"dt": "Role", "filters": [["name", "in", ["Tier Manager"]]]},
  ]
  ```
  A fixture without filters exports every record of that DocType on your dev site, other apps' and test data too.
- Export from the dev site, where you made the records: `bench --site <dev site> export-fixtures --app my_app`. It
  writes `my_app/fixtures/<doctype>.json`. Read the diff before committing: only your records, no site-specific values.
- Migrate syncs fixtures on every site and overwrites what a site changed in those records. Do not ship as a fixture
  what each customer configures for themselves (settings with their own values): set defaults in a patch, once.
- Removing a record from the fixtures does not delete it from the sites. A patch deletes it if it must go.
- Not for transactions or masters with customer data, and never for a DocType Frappe refuses as a fixture.

Then `tbo_dev` `bench` `migrate` on the dev site and check the records.
