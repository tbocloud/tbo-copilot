---
name: Frappe DocTypes and fields
description: Use when adding or changing a DocType, field, child table, naming or permissions in a Frappe or ERPNext app: a new DocType, or a Custom Field or Property Setter the app ships; then migrate.
---

# Frappe DocTypes and fields

Work in the app's repository and on the dev site of your own bench, never on a live site.

## Which one

| The task needs | Make |
|---|---|
| A new kind of record that belongs to the app | A DocType in one of the app's modules |
| A field on your app's own DocType | A field in that DocType's JSON |
| A field on another app's DocType (ERPNext's Sales Invoice, Frappe's User) | A Custom Field that your app ships |
| Another app's field changed (label, `reqd`, `hidden`, options, default) | A Property Setter that your app ships |

**Never edit a core app** (frappe, erpnext, hrms, or any app TBO does not own): not its code, not its DocType JSON. The
next update overwrites the change. Change it from your app: Custom Fields, Property Setters, `doc_events` in
`hooks.py`, and on Frappe 16 `extend_doctype_class` (a mixin). `override_doctype_class` replaces the whole class: only
when nothing else works, and say why in the PR.

## A new DocType

1. Developer mode on the dev site, once: `bench --site <dev site> set-config developer_mode 1`.
2. Create it in the desk with **Module** set to a module of your app. Never **Custom**: a custom DocType lives only in
   one site's database. The files appear in `<app>/<module>/doctype/<doctype>/`: the `.json`, the controller `.py`,
   the form `.js` and `test_<doctype>.py`. By hand: copy the folder of an existing DocType of the app and keep the
   JSON's format and key order.
3. After every change to a DocType's JSON: `tbo_dev` `bench` with `command: migrate` and `site: <dev site>` (without
   `site` it migrates the test site), then `job_status` with the **`job` id that answer gave** until that job has
   finished (not just the latest job: a check that finished meanwhile says nothing about the migrate). Go on only
   when it says **`passed`**: `failed` or `error` means the migration may be incomplete (a patch after the schema
   sync can fail, so some changes may be in and others not), so read its detail, fix the cause and migrate again. Migrate the test site too before `run_tests`. Commit the JSON together with the code that
   uses it.

**Fields**
- `fieldname` in snake_case, never renamed once there is data. A Link's `options` is a DocType that exists.
- `reqd`, `unique`, `in_list_view`, `in_standard_filter` only where the task needs them.
- `search_index` on a field that large lists are filtered or sorted by.
- Changing a field's type, or removing a field that holds data: a patch moves the data first (skill "Frappe patches
  and fixtures"). Frappe does not drop a removed field's column.

**Child tables**
- The child is its own DocType with **Is Table** (`istable: 1`) and no permissions of its own.
- The parent has a **Table** field whose `options` is the child DocType.
- Rows are read and saved with the parent: `doc.append("tiers", {...})`, then `doc.save()`. Never insert or save a row
  on its own.

**Naming** (`naming_rule` and `autoname`)
- `By "Naming Series" field` (`naming_series:` with a `naming_series` Select field) for business documents.
- `By fieldname` (`field:tier_code`) when a field is unique and never changes.
- `Expression` (`format:TIER-{####}`), `Autoincrement`, `Random`, `UUID`, or `By script` (an `autoname` method).
- Choose one that stays unique and readable. Renaming records later is slow and touches every link to them.

**Permissions**
- The JSON's `permissions` table: one row per role, the least each role needs.
- `permlevel` 1 or higher for fields only some roles may see or change.
- `is_submittable` only when the record must be locked after approval (submit, cancel, amend).
- Rules that depend on the record (only the owner's, only their company's): a `has_permission` hook and
  `permission_query_conditions` in `hooks.py`. On Frappe 16 a `has_permission` hook must return `True` to allow:
  `None` counts as a refusal (skill "Frappe v16 checks").

## A Custom Field or Property Setter that the app ships

Pick one way per app and keep to it.

- **Fixtures.** Make the field in the desk (Customize Form) on the dev site. Customize Form does not set the
  **Module** of the Custom Fields and Property Setters it makes: open each new record (Custom Field list, Property
  Setter list) and set **Module** to your app's module, or the filter below leaves it out. List them in `hooks.py`,
  always with a filter:
  ```python
  fixtures = [
      {"dt": "Custom Field", "filters": [["module", "=", "My App"]]},
      {"dt": "Property Setter", "filters": [["module", "=", "My App"]]},
  ]
  ```
  Then `bench --site <dev site> export-fixtures --app my_app` and commit `my_app/fixtures/*.json`. Open the exported
  files and check every field and property you made is there (a missing one has no Module). Without a filter the
  export takes every customisation on the site, other apps' too.
- **In code.** `create_custom_fields({"Sales Invoice": [{...}]}, update=True)` from
  `frappe.custom.doctype.custom_field.custom_field`, called from `after_install` and from a patch for sites that
  already have the app. `make_property_setter(...)` from `frappe.custom.doctype.property_setter.property_setter` for
  a property.

Migrate syncs fixtures **after** the patches. A patch that needs a fixture's field creates it itself
(`create_custom_fields`).

## Check it

- `tbo_dev` `bench` `migrate`, then open the form and the list on the dev site.
- A test that makes the record (`frappe.get_doc({...}).insert()`) and proves the rule the task asks for, including the
  case that must fail. `tbo_dev` `run_tests`.
