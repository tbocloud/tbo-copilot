---
name: TBO Frappe conventions
description: Use when writing or reviewing Python, DocTypes, APIs, tests or frappe-ui code in a Frappe or ERPNext app for TBO: TBO's rules for controllers, queries, whitelisted functions, tests and UI tokens.
---

# TBO's Frappe conventions

The repository's own `AGENTS.md` (or `CLAUDE.md`) comes first; these are the rules TBO applies everywhere else
(taken from TBO Support's `AGENTS.md`).

## Before writing

- **Search before you create.** A helper, field, report or test factory may already exist. No duplicates, no dead code,
  no new dependency without a reason. Keep the change to what the task asks.
- **Read a site before you assume.** Query the dev site for the records, custom fields and settings you rely on. Never
  write to a site's data unless the person asks, and never touch a live site.

## Controllers (DocType classes)

- Lifecycle hooks (`validate`, `before_save`, `on_update`, `after_insert`, `on_trash`, …) hold **no inline logic**:
  each calls methods. The methods sit below the hooks on the class, one job each; `@staticmethod` only for pure
  transformations.
- Set every field, then `save()` once, in the hook or the method that owns the whole change. A helper that changes a
  related document takes it as an argument and changes it in memory; the caller saves. Never fetch the same document
  twice in one hook.

## Queries

- New code uses `frappe.qb` (or `frappe.qb.get_query(...)`) rather than `frappe.db.get_all`; pass
  `ignore_permissions=False` where the user's permissions must apply.
- Never build SQL with f-strings or `%` from input: use the query builder or parameters.

## Whitelisted functions (APIs)

- Every argument and the return value carry **type hints**: Frappe checks them on each call, and Semgrep fails a
  whitelisted function without them.
- Anything that changes data is `@frappe.whitelist(methods=["POST"])`; a GET never has side effects.
- Check permissions in the function (`frappe.has_permission(...)`, `frappe.only_for(...)`), not only in the UI.
- Never call `frappe.db.commit()` in a request; Frappe commits at the end. Background jobs commit at their own end.

## Messages and errors

- Every text a user sees goes through `_("...")`, with `{0}` placeholders and `.format(...)`, never an f-string
  inside `_()`.
- `frappe.throw(_("..."), SomeError)` with the specific error type; no bare `except:`.

## Tests

- Test files sit beside the code: `test_<doctype>.py` in the DocType's folder, or `<app>/tests/test_<module>.py`.
  Frappe 15: `from frappe.tests.utils import FrappeTestCase`; Frappe 16: `from frappe.tests import IntegrationTestCase`.
- Factories and helpers live in the app's `test_utils.py` (create it if there is none), never inside a test file:
  `make_<doctype>(...)`, `enable_<feature>()` / `disable_<feature>()`, each with a docstring unless its name says it all.
- A test proves the behaviour the task asks for, including the case that must fail. Run the module's tests locally
  (`tbo_dev` `run_tests`); CI runs the whole suite.

## Patches and DocTypes

- A schema change is the DocType's JSON (exported by the desk in developer mode, or edited by hand in the same
  format). A data change is a patch in `patches.txt`: idempotent, safe to run twice. Details in the skill
  "New Frappe app, DocTypes, patches and tests".

## Frontend (frappe-ui apps)

- frappe-ui **v2 tokens**: `bg-surface-base`, `bg-surface-gray-1…10`, `text-ink-gray-1…9`, `text-ink-base`,
  `border-outline-gray-1…9`. The v1 names (`bg-surface-white`, `text-ink-white`, `surface-selected`) compile to nothing;
  `ink-*` is for text only.
- Data through frappe-ui's `createResource`, `createListResource`, `createDocumentResource`; Tailwind utilities for
  layout. One accent colour for the primary action, everything else neutral; contrast at least 4.5:1, keyboard
  reachable, visible focus.

## Docs and commits

- When a feature has a spec or docs page, update it in the same change.
- Commit titles are conventional and lower case: `feat(scope): …`, `fix(scope): …`, `test: …`, `docs: …`.
