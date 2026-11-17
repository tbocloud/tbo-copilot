---
name: Frappe print formats
description: Use when building or changing a print format (invoice, quotation, delivery note) in a Frappe or ERPNext app: a Jinja format kept in the app, letter heads, rendering in code, and testing the PDF.
---

# Frappe print formats

## Keep it in the app

A print format made only in the desk lives in one site's database. Ship it with the app:

1. Developer mode on the dev site. A new **Print Format**: **DocType**, **Module** a module of your app, **Standard**
   Yes, **Custom Format** on, **Print Format Type** Jinja. Saving writes `<app>/<module>/print_format/<name>/`.
2. Put the template in `<name>.html` in that folder (the format's name in snake_case). For a standard format of an
   app's module, Frappe reads that file, so the template is reviewed in git like code. Keep the JSON's `html` empty.
3. Another site gets it with `tbo_dev` `bench` `migrate`. Make it the DocType's default only if the task asks (a
   Property Setter for `default_print_format` that the app ships).

## The template

- `doc` is the document; `doc.items` (or any table field) its rows.
- Format values the way the desk does: `{{ doc.get_formatted("grand_total") }}`, `{{ row.get_formatted("rate", doc) }}`.
  Currency, dates and precision then follow the site's settings.
- Labels through `{{ _("Invoice") }}`.
- Frappe's Jinja does **not** escape by itself. Text a user typed (a name, a remark) goes through `| e`. Only a Text
  Editor field, which holds HTML on purpose, prints as it is.
- A misspelled variable prints itself (`{{ doc.custmer }}`) instead of failing: read the output.
- One `frappe.db.get_value(...)` for a single value is fine. No query inside a loop over rows: a print of 300 rows runs
  it 300 times, and a bulk print or a PDF in an email multiplies that. Fetch what the format needs once, in a Python
  function exposed through the `jinja` hook:
  ```python
  # hooks.py
  jinja = {"methods": ["my_app.printing.tier_summary"]}
  ```
  and in the template `{% set tiers = tier_summary(doc.name) %}`. The function reads with permissions in mind and
  returns plain values.
- Styles in a `<style>` block at the top, or the format's **CSS**. The PDF is made by wkhtmltopdf unless the format or
  the site picks another generator (`pdf_generator`): wkhtmltopdf has no flexbox or grid, so use tables and fixed
  widths. A page break: `<div class="page-break"></div>`.
- A part shared by several formats: a file in the app, `{% include "my_app/templates/print/tier_table.html" %}`.

## Letter heads

The logo, the company's address and the footer belong in a **Letter Head** record, chosen per print (the company's
default unless the person picks another). Do not draw them in the format: the customer can then change their logo
without code. Check the format with a letter head and without one (`no_letterhead=1` in the print view's address).

## Rendering in code

- `frappe.get_print("Sales Invoice", name, print_format="Tier Invoice")` returns the HTML; `as_pdf=True` returns the
  PDF's bytes.
- `frappe.attach_print("Sales Invoice", name, print_format="Tier Invoice")` gives an attachment for
  `frappe.sendmail(attachments=[...])`.
- `frappe.render_template("my_app/templates/print/tier_table.html", {"doc": doc})` renders a template file of the app
  (or a template string) with a context. Use it for an email body or a part of a page, not to build a print format by
  hand.

## Check it

- On the dev site: open the document, **Print**, pick the format, with and without a letter head. Then **PDF**: the PDF
  is where widths, page breaks and fonts go wrong.
- The same in a browser: `/printview?doctype=Sales%20Invoice&name=<name>&format=Tier%20Invoice` and
  `/api/method/frappe.utils.print_format.download_pdf?doctype=Sales%20Invoice&name=<name>&format=Tier%20Invoice`.
- Try a document with many rows, a long customer name and an empty optional field.
- A test can render it: `frappe.get_print(...)` and check a value appears, and `as_pdf=True` returns bytes starting
  with `%PDF`. `tbo_dev` `run_tests`.
