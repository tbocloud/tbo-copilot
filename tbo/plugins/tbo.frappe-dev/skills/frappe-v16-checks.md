---
name: Frappe v16 checks
description: Use on every change for a Frappe 16 site (TBO's sites run v16), and on code moved from an older app: query fields and order_by, permission hooks, sendmail, private files, Python 3.14 and Node 24.
---

# Frappe v16 checks

TBO's sites run Frappe 16. Run these checks on every change, and on any code brought over from an older app. Each one
is a way code that looks right fails on v16.

## Query fields: no SQL functions as strings

`frappe.get_all`, `frappe.get_list`, `frappe.db.get_value` and `frappe.db.get_values` build their query with the query
builder, which refuses a function written as a string: `fields=["sum(grand_total) as total"]` or `"count(name)"`
throws "SQL functions are not allowed as strings in SELECT".

```python
frappe.get_all(
    "Sales Invoice",
    filters={"docstatus": 1},
    fields=["customer", {"SUM": "grand_total", "as": "total"}],
    group_by="customer",
)
frappe.get_all("ToDo", fields=[{"COUNT": "*", "as": "count"}])
```

- The dict form knows COUNT, SUM, AVG, MAX, MIN, ABS, IFNULL, CONCAT, NULLIF, EXTRACT, LOCATE, TIMESTAMP, NOW, YEAR,
  MONTH, MONTHNAME, QUARTER, and ADD, SUB, MUL, DIV. For anything else write the query with `frappe.qb` and
  `frappe.query_builder.functions` (`Sum`, `Count`, `Coalesce`, …).
- A string in `fields` is a field name, `field as alias`, `link_field.field`, `child_table.field` or `*`.

## `order_by` and `group_by`: field names only

- `order_by="posting_date desc, name asc"` works.
- A backticked name (`` "`posting_date` desc" ``) is refused; only the full `` `tabSales Invoice`.`posting_date` ``
  form passes. Drop the backticks.
- An expression (`"ifnull(due_date, posting_date) desc"`) is refused. Sort by an expression in `frappe.qb`.

## Permission hooks return True

A `has_permission` hook in `hooks.py` can only refuse; the roles still decide what is allowed. On Frappe 16 any falsy
answer refuses, `None` too, so a hook that ends without `return` refuses everyone. Return `True` explicitly when the
hook has no objection:

```python
def has_permission(doc, ptype=None, user=None, debug=False) -> bool:
    if doc.confidential and user not in allowed_users(doc):
        return False
    return True
```

## `frappe.sendmail` needs a recipient

Called with `communication=` and no `recipients`, `cc` or `bcc`, it throws "At least one recipient is required" and
the whole action fails; without a communication it quietly sends nothing. Build the list, drop empty values, and when
it is empty skip the mail (and say so where it matters) instead of calling `sendmail`.

## Private files: check first, then copy

A new File row with the `file_url` of an existing private file is refused (`File.validate_private_file_access`)
unless the current user is Administrator, uploaded that file, or can read it. `ignore_permissions=True` does not skip
the check. Code that copies attachments to another document (an order's to its invoice, a ticket's to a task) often
runs as someone who cannot read the original: a background job, a portal user, a webhook.

Never get around it by acting as the file's uploader: that copies a file the asker may not read onto a document they
can, and the uploader may not even write the destination.

**Who may cause the copy.** A copy shows the file to everyone who can read the destination, including people who
cannot read the source. So the asker's own rights are not enough on their own, and neither is a link between the
documents (this invoice was made from that order). Every copy, asked by a person or made by a job, needs a **rule the
owner of that data agreed in the task** (for example "an invoice made from an order carries the order's attachments,
for the invoice's readers"). Write the rule as a function, check it before the copy, copy only what it covers, and
name it in the PR; never only "the job may". When a person asks, check also that they can read the source and write
the destination.

**Where to switch identity.** Make the copy as Administrator, the one identity the check always lets through, in a
**background job**, never in the request: `frappe.set_user` empties `frappe.form_dict` and `frappe.session.data`,
sets the session id to the user's name, and switching back restores none of it, while Frappe still runs the
`after_request` hooks and saves the session after the handler returns. A job has no request state to lose.
`frappe.set_user` also leaves `@request_cache` results in place, so a request-cached function that depends on the user
without taking it as an argument would answer for the wrong identity on either side of a switch.

```python
# In the request: the checks, as the asker; then the job.
source = frappe.get_doc("File", file_name)
if not (
    copy_allowed(source, doctype, name)  # the data owner's rule, in the app
    and frappe.has_permission(source.attached_to_doctype, "read", source.attached_to_name)
    and frappe.has_permission(doctype, "write", name)
):
    frappe.throw(_("You may not copy this file there."), frappe.PermissionError)
frappe.enqueue(
    "my_app.files.copy_private_file",
    file_name=file_name, doctype=doctype, name=name, enqueue_after_commit=True,
)


# my_app/files.py: the job checks the rule again (things may have changed) and copies as Administrator.
def copy_private_file(file_name, doctype, name):
    source = frappe.get_doc("File", file_name)
    if not copy_allowed(source, doctype, name):
        # a failure, not a quiet success: the job shows as failed, with this reason, for someone to look at
        frappe.throw(
            _("The copy rule no longer allows copying {0} to {1} {2}.").format(file_name, doctype, name),
            frappe.PermissionError,
        )
    frappe.set_user("Administrator")
    frappe.get_doc({
        "doctype": "File",
        "file_url": source.file_url,
        "is_private": 1,
        "attached_to_doctype": doctype,
        "attached_to_name": name,
    }).insert()
```

A job that copies by itself (no person asked) checks only `copy_allowed`. When the rule refuses in the job, the job
fails with the reason instead of ending quietly, so a missing attachment can be traced; tell the person who asked
where it matters (a comment on the destination, or a notification).

Test it as a user who cannot read the original file.

## Python 3.14 and Node 24

- A Frappe 16 bench runs Python 3.14 and Node 24 or later. Check the bench (`<bench>/env/bin/python --version`,
  `node --version`) before trusting a test run or a build.
- Modules removed from the standard library in Python 3.13 (`imghdr`, `cgi`, `pipes`, `telnetlib`, `crypt`, …) are
  gone: importing one fails when the app loads.
- `datetime.utcnow()` is deprecated: use `frappe.utils.now_datetime()` (the site's time zone) or
  `datetime.now(timezone.utc)`.
- A new Python or JavaScript dependency must support Python 3.14 or Node 24. Check before adding it.

## Search the change

From the repository, on the files the branch changed:

```bash
git grep -nE "['\"](count|sum|avg|max|min|ifnull|coalesce|concat|date)\(" -- '*.py'
git grep -nE 'order_by=.*`' -- '*.py'
git grep -n -A12 "def has_permission" -- '*.py'
git grep -n "frappe.sendmail" -- '*.py'
git grep -nE "\"doctype\": \"File\"|new_doc\(\"File\"\)" -- '*.py'
```

Read every match against the checks above. Then `tbo_dev` `run_tests` on a Frappe 16 dev bench (`bench version`).
