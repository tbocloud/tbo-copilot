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
  `reference_doctype`, `doctype_event`, `api_method`, `allow_guest`, `enable_rate_limit`, `rate_limit_count`,
  `rate_limit_seconds`, `event_frequency`, `disabled`, `script`.
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
from frappe.rate_limiter import rate_limit

@frappe.whitelist(methods=["GET", "POST"])  # the methods the script answered; narrow them only after the callers moved
@rate_limit(limit=5, seconds=60)  # only when the script had enable_rate_limit: its rate_limit_count and _seconds
def get_tier_price(item_code: str, qty: float) -> float:
    ...
```

- An API Server Script answers GET and POST. Keep both while callers may use either; restrict to POST (or GET for a
  read) in a later change, once every caller is known to use it.
- A script with `enable_rate_limit` keeps the same limit through `@rate_limit` (its `rate_limit_count` and
  `rate_limit_seconds`); dropping it would remove a protection.

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

Once the app's code is deployed, the scripts must not run. Ship that with the change: a patch under
`[post_model_sync]` that disables them by name if they exist (skill "Frappe patches and fixtures"). Save each script
as a document, so Frappe clears its map of Server Scripts too; a bare `frappe.db.set_value` leaves a worker that
already loaded the map running the disabled script.

```python
import frappe


def execute():
    for doctype, name, field, value in (
        ("Server Script", "Sales Invoice - tier price", "disabled", 1),
        ("Client Script", "Sales Invoice - tier form", "enabled", 0),
    ):
        if frappe.db.exists(doctype, name):
            doc = frappe.get_doc(doctype, name)
            doc.set(field, value)
            doc.save(ignore_permissions=True)  # on_update clears the Server Script map
```

**No moment when both run.** On a deploy the new code can be live before migrate runs the patch, so a document event
could run the new hook and the old Server Script once each. Close that gap one of two ways, and say which in the PR:

- **Guard the new code** until the patch has run: the moved hook returns at once while the old script is still
  enabled (`if not frappe.db.get_value("Server Script", "Sales Invoice - tier price", "disabled"): return`), and the
  guard is removed in a later change; or
- **A short pause:** the site in maintenance mode (no requests, workers stopped) from the deploy until the migrate
  has run.

Disable, never delete: the person can turn one back on if something was missed. Say in the PR which scripts the patch
disables and what to check on the site after the deploy.
