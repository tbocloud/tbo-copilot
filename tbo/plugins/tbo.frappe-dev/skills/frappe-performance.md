---
name: Frappe performance
description: Use when a Frappe or ERPNext page, report, API or job is slow, or when writing code over many records: find the slow queries, add indexes, remove N+1 get_doc loops, fetch only the fields needed, cache.
---

# Frappe performance

Measure first, change one thing, measure again. Work on the dev site with data of a realistic size.

## Find what is slow

- **Recorder** (desk, `/app/recorder`): start it, do the slow action once, stop it. It lists each request's queries
  with their time, count and `EXPLAIN`. Many similar queries is an N+1 loop; one slow query is a missing index or a
  query without a bound.
- The slow query log of the dev site's MariaDB, for a job or a scheduler event.
- For one query: `frappe.db.sql("EXPLAIN " + query, values, as_dict=True)`, or `.run(debug=True)` on a `frappe.qb`
  query to print it. In `EXPLAIN`, `type: ALL` with many `rows` on a large table means a full scan; `key` is the index
  used.

## Slow queries

- Query with `frappe.qb`, with a `WHERE` on indexed columns and a `LIMIT` where a list is shown:
  ```python
  from frappe.query_builder.functions import Sum

  si = frappe.qb.DocType("Sales Invoice")
  rows = (
      frappe.qb.from_(si)
      .select(si.customer, Sum(si.outstanding_amount).as_("outstanding"))
      .where((si.docstatus == 1) & (si.company == company) & (si.posting_date >= from_date))
      .groupby(si.customer)
  ).run(as_dict=True)
  ```
- No function on an indexed column in `WHERE` (`DATE(posting_date) = …`, `IFNULL(x, '') = …`): the index is not used.
  Compare the column itself with a range.
- No `LIKE '%text%'` on a large table for a search box: a prefix (`LIKE 'text%'`) can use an index.

## Indexes

- A field of your own DocType: `search_index: 1` in its JSON, then migrate.
- Several columns together (`WHERE company = … AND posting_date >= …`): `frappe.db.add_index(doctype, ["company",
  "posting_date"])` in `on_doctype_update()` of your DocType's module, which runs when the DocType is synced.
- A field of another app's DocType: `search_index` on your Custom Field, or `frappe.db.add_index(...)` in a patch
  (skill "Frappe patches and fixtures"). `add_index` does nothing when the index exists, so the patch can run twice.
- Index what the slow queries filter, join and sort by. Each index slows writes a little: not every field.
- Adding an index to a table of millions of rows takes time on migrate: say so in the PR.

## N+1: `get_doc` in a loop

```python
# slow: one query (or several, with child tables) per invoice
for name in frappe.get_all("Sales Invoice", filters=filters, pluck="name"):
    doc = frappe.get_doc("Sales Invoice", name)
    total += doc.outstanding_amount

# fast: one query, only the fields needed
rows = frappe.get_all("Sales Invoice", filters=filters, fields=["name", "customer", "outstanding_amount"])
```

- `frappe.get_doc` loads the whole document with all its child tables. Use it when you need the document's methods or
  will save it; read values with `frappe.get_all(..., fields=[...])`, `frappe.db.get_value(...)` or `frappe.qb`.
- `frappe.get_all` (like `frappe.db.get_value` and `frappe.qb`) checks no permission. For a list a user sees, use
  `frappe.get_list`, which applies their permissions; keep `get_all` for internal work, as in the skill "Frappe
  conventions".
- `frappe.get_all` with `fields` lists only the columns needed; never `fields=["*"]` on a wide table.
- Fetch related records once (`filters={"parent": ("in", names)}`) and group them in Python, not one query per row.
- In a loop that saves many documents, no `frappe.db.commit()` per row. Many rows at once is a background job or, for
  existing data, a patch that commits in batches.

## Caching

- `frappe.get_cached_doc` and `frappe.get_cached_value` for records that rarely change (settings, Company, Item Group);
  never for something the same request changes.
- `@redis_cache(ttl=...)` from `frappe.utils.caching` for a function whose result is the same for everyone for a
  while. Clear it when its source changes: in `on_update` of that DocType, register the decorated function's own
  `clear_cache()` (it clears every argument's entry) to run after the save commits,
  `frappe.db.after_commit.add(get_tier_prices.clear_cache)`. Cleared before the commit, a request still reading the
  old row could fill the cache again with the old value. `frappe.cache.delete_value` does not reach the decorator's
  keys. Where a stale value for up to `ttl` would do harm, do not cache it.
- `@request_cache` keeps a result only until the request ends (`frappe.local.request_cache`) and has no
  `clear_cache()`. Use it for a value that cannot change within the request; if the request itself changes the
  source, call the function again only through code that does not rely on the cached answer.
- Cache results, not permissions: a cached list must not show one user's records to another.

## Long work out of the request

A request that runs for more than a few seconds becomes a background job: `frappe.enqueue("my_app.jobs.rebuild",
queue="long", job_id=..., deduplicate=True, enqueue_after_commit=True)`; the user gets a message, and the job reports
when it is done. `enqueue_after_commit=True` starts the job only after the request's changes are saved, so a job that
reads what the request just wrote finds it.

## Prove it

- The Recorder again: fewer queries, less time. Put both numbers in the PR.
- A test still proves the behaviour; `tbo_dev` `run_tests`. A test can also assert the query count stays small
  (`self.assertQueryCount(n)` on Frappe 16's `IntegrationTestCase`).
