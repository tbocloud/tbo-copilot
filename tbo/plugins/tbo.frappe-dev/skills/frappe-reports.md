---
name: Frappe reports
description: Use when building or changing a Script Report or Query Report in a Frappe or ERPNext app: its files, filters, columns, who may run it (ref_doctype, roles), and keeping it fast.
---

# Frappe reports

## Which kind

- **Script Report**: Python builds the rows. The usual choice: any logic, several queries, totals, a chart.
- **Query Report**: one read-only SQL query kept in the report's JSON. Only for a plain listing. Frappe runs only a
  `SELECT`, `WITH` or `EXPLAIN`, and the filters reach it as parameters.
- **Report Builder**: made by users in the desk. Nothing to code.

## Make it

1. Developer mode on the dev site. In the desk, a new **Report**: **Is Standard** Yes, **Module** a module of your app,
   **Report Type**, **Ref DocType**. Saving writes `<app>/<module>/report/<report_name>/`: the `.json`, and for a
   Script Report the `.py` and `.js`.
2. Commit the folder. Another site gets it with `tbo_dev` `bench` `migrate`.

## Script Report

`<report_name>.py`:

```python
import frappe
from frappe import _


def execute(filters: dict | None = None):
    filters = frappe._dict(filters or {})
    return get_columns(), get_data(filters)


def get_columns() -> list[dict]:
    return [
        {"label": _("Invoice"), "fieldname": "name", "fieldtype": "Link", "options": "Sales Invoice", "width": 160},
        {"label": _("Outstanding"), "fieldname": "outstanding_amount", "fieldtype": "Currency", "width": 120},
    ]
```

- `execute` returns `columns, data`, and may add `message, chart, report_summary, skip_total_row` in that order.
- A row is a dict keyed by `fieldname` (or a list in column order).
- Every label goes through `_()`: Frappe's Semgrep rules fail a report label without it.
- Read with `frappe.qb` or `frappe.get_all`, the filters passed as values, never formatted into SQL.
- A report shows whatever its queries return. Use `frappe.get_list` (it applies the user's permissions), or filter by
  the user's company or permission yourself, when the report must not show every record.

`<report_name>.js`:

```javascript
frappe.query_reports["Outstanding by Tier"] = {
	filters: [
		{
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			reqd: 1,
			default: frappe.defaults.get_user_default("Company"),
		},
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", reqd: 1 },
	],
};
```

A filter's `fieldname` is its key in `filters` in Python. Make the filters that bound the data (company, dates) `reqd`.

## Query Report

- The SQL is the JSON's `query`, with `%(fieldname)s` for each filter. The filters go in a `.js` beside it, as for a
  Script Report.
- Columns come from the aliases: `name as "Invoice:Link/Sales Invoice:160"`, `grand_total as "Total:Currency:120"`.

## Who may run it

- **Ref DocType**: running the report needs the **Report** permission on it; export and print need Export and Print.
  Choose the DocType whose data the report shows.
- **Roles** (the JSON's `roles`): who sees and runs it. List the roles the task names. A report with no roles is open
  to everyone with the Report permission on its Ref DocType.

## Keep it fast

- Required filters bound every query (a date range, a company). No query on a large table without a `WHERE`.
- One query per table with only the `fields` needed, joined or grouped in SQL. Never `frappe.get_doc` per row.
- Indexes for the columns in `WHERE` and `ORDER BY` (skill "Frappe performance").
- Frappe turns a Script Report that runs longer than 15 seconds into a **Prepared Report** (queued, run in the
  background) unless `disable_prepared_report_automation` is set. For a report known to be heavy, set
  `prepared_report` yourself and say so in the PR.

## Check it

- Run it on the dev site with realistic filters, as a user with only the roles it names, not Administrator.
- A test can call `execute(filters)` and check the columns and a known row. `tbo_dev` `run_tests` with that module.
