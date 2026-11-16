---
name: Client and Server Scripts into app code
description: Use when moving a site's Client Scripts or Server Scripts into a Frappe app: doctype_js, doc_events, scheduler_events, whitelisted methods, tests, and then disabling the scripts so nothing runs twice.
---

# Client and Server Scripts into app code

A script made in the desk lives in one site's database: no review, no tests, no history. Moving it into the app makes
it code like any other. The behaviour must stay the same, and the old script must stop running once the app's code
runs, or it runs twice.

## 1. Collect them

- Read each script on the dev site (a copy of the customer's data), or take the text the person gives you:
  **Client Script**: `dt`, `view` (Form or List), `enabled`, `script`. **Server Script**: `script_type`,
  `reference_doctype`, `doctype_event`, `api_method`, `event_frequency`, `disabled`, `script`.
- Only enabled ones matter. List them with their names in the PR: the person checks the list against the live site.
- Never change or disable a script on a live site from here.

## 2. Client Script → `doctype_js`

- Form view: `<app>/public/js/<doctype>.js`, and in `hooks.py`:
  `doctype_js = {"Sales Invoice": "public/js/sales_invoice.js"}`. List view: `doctype_list_js`.
- The script body moves as it is (`frappe.ui.form.on("Sales Invoice", {...})`). Text the user sees through `__()`.
- `tbo_dev` `bench` with `command: build` and the app, then reload the form.

## 3. Server Script → Python in the app

| `script_type` | Becomes |
|---|---|
| DocType Event | A function in `doc_events` (or a method on your own DocType's controller) |
| API | A whitelisted function |
| Scheduler Event | A function in `scheduler_events` |
| Permission Query | A function in `permission_query_conditions` |

**DocType Event.** The event names map like this: Before Insert `before_insert`, Before Validate `before_validate`,
Before Save `validate`, After Save `on_update`, Before Submit `before_submit`, After Submit `on_submit`, Before Cancel
`before_cancel`, After Cancel `on_cancel`, Before Delete `on_trash`, After Delete `after_delete`, Before Save
(Submitted Document) `before_update_after_submit`, After Save (Submitted Document) `on_update_after_submit`.

```python
# hooks.py
doc_events = {"Sales Invoice": {"validate": "my_app.selling.sales_invoice.validate"}}

# my_app/selling/sales_invoice.py
def validate(doc, method=None):
    ...
```

**API.** The script's `api_method` was called as `/api/method/<api_method>`.

```python
@frappe.whitelist(methods=["POST"])  # GET only when it changes nothing
def get_tier_price(item_code: str, qty: float) -> float:
    ...
```

- Arguments come in as parameters with type hints (the script read `frappe.form_dict`); return the value (the script
  set `frappe.response["message"]`). Check permissions inside the function.
- A script with `allow_guest` becomes `@frappe.whitelist(allow_guest=True)` only if guests truly need it; say why in
  the PR.
- Callers that still use the old name keep working through
  `override_whitelisted_methods = {"get_tier_price": "my_app.selling.api.get_tier_price"}` in `hooks.py`; Frappe
  applies it before it looks for a Server Script. Otherwise change the callers in the same PR.

**Scheduler Event.** `event_frequency` Hourly, Daily, Weekly, Monthly become the keys `hourly`, `daily`, `weekly`,
`monthly` of `scheduler_events` (the Long ones `hourly_long`, `daily_long`, …); Cron becomes
`"cron": {"<cron_format>": ["my_app.jobs.fn"]}`.

**What changes in Python.** A Server Script runs in a sandbox with a part of the `frappe` API. In the app you write
normal code: import what you need, follow the skill "TBO Frappe conventions", and never `frappe.db.commit()` in a
request. Keep the same order of effects and the same messages.

## 4. Tests

A test per moved behaviour, written against the app's function, on the dev site with the old script **disabled** (or
the test proves the script's work, not the app's). `tbo_dev` `run_tests`.

## 5. Disable the scripts

Once the app's code is deployed, the scripts must not run. Ship that with the change, so there is no moment when both
run: a patch under `[post_model_sync]` that disables them by name if they exist (skill "Frappe patches and fixtures"):

```python
def execute():
    for name in ("Sales Invoice - tier price",):
        if frappe.db.exists("Server Script", name):
            frappe.db.set_value("Server Script", name, "disabled", 1)
    for name in ("Sales Invoice - tier form",):
        if frappe.db.exists("Client Script", name):
            frappe.db.set_value("Client Script", name, "enabled", 0)
```

Disable, never delete: the person can turn one back on if something was missed. Say in the PR which scripts the patch
disables and what to check on the site after the deploy.
