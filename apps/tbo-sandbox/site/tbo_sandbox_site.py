"""Called inside a sandbox site by the runner (`bench --site sandbox.localhost execute frappe.tbo_sandbox_site.<name>`).

Copied into the sandbox image's own Frappe package (site/Dockerfile): bench executes only code of an installed app.

Only reads, or writes that are rolled back: the sandbox is a throwaway copy, but a dry run
must leave it as it found it, so the next check starts from the same data.
"""

import re
import traceback

import frappe

FRAME = re.compile(r'File "[^"]*/apps/([a-z_0-9]+)/[^"]*", line \d+, in (\S+)')


def error_signatures(since: str) -> list[str]:
    """One line per new kind of error since `since`: the exception and the first frame in an app other than Frappe."""
    signatures = []
    for row in frappe.get_all(
        "Error Log", filters={"creation": [">", since.replace("T", " ")[:26]]}, fields=["method", "error"], limit=200
    ):
        text = row.error or ""
        last = next((line.strip() for line in reversed(text.splitlines()) if line.strip()), row.method or "error")
        exception = last.split(":", 1)[0][:120]
        frames = [m for m in FRAME.findall(text) if m[0] != "frappe"]
        where = f"{frames[-1][0]}.{frames[-1][1]}" if frames else (row.method or "")[:80]
        signature = f"{exception} at {where}" if where else exception
        if signature not in signatures:
            signatures.append(signature)
    return signatures


def try_changes(changes: list) -> list:
    """Each change saved with the site's own code, then rolled back: what would happen if it were applied."""
    trials = []
    for change in changes:
        trial = {"doctype": change.get("doctype"), "name": change.get("name"), "ok": True}
        frappe.db.savepoint("tbo_try")
        try:
            _apply(change)
        except Exception as e:  # noqa: BLE001 - every refusal is the answer
            trial.update(ok=False, error=f"{type(e).__name__}: {frappe.utils.strip_html(str(e))[:500]}")
            frappe.clear_last_message()
            if not isinstance(e, frappe.ValidationError):
                trial["trace"] = traceback.format_exc()[-1500:]
        finally:
            frappe.db.rollback(save_point="tbo_try")
        trials.append(trial)
    frappe.db.rollback()
    return trials


def _apply(change: dict):
    values = change.get("values") or {}
    if (change.get("action") or "update") == "create":
        frappe.get_doc({"doctype": change["doctype"], **values}).insert()
        return
    doc = frappe.get_doc(change["doctype"], change["name"])
    doc.update(values)
    for row in change.get("rows") or []:
        child = next((r for r in doc.get(row["table"]) or [] if r.name == row["name"]), None)
        if child is None:
            raise frappe.ValidationError(f"{change['doctype']} {change['name']} has no row {row['name']} in {row['table']}")
        child.update(row.get("values") or {})
    for row in change.get("add_rows") or []:
        doc.append(row["table"], row.get("values") or {})
    doc.save()
