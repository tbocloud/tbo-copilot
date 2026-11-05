# Phase 3: Setting and data corrections, approved by a senior

**Status:** approved by the owner 13 Oct 2026: start now on the Mac and the local pair; submitted documents listed for a person; a correction applied right after the senior's approval; customer mistakes corrected only when an agent asks. **C7, H13, H14 and W6 built and tested on the Mac, 13 Oct 2026 (local commits, see As built)**; the checkpoint on the local pair waits for the owner (customer.localhost's write switch and write list for the demo records, and a reconnection for its approval key). **Estimate:** about 11 developer-days: C7 (the guard on the customer's site, ≈ 3), H13 (change sets, the check, the senior's approval and applying, ≈ 4), H14 (code and data together, Undo, the older write path, docs, ≈ 2), W6 (the worker prepares change sets, ≈ 2). **Design reference:** `../system-design.md` §4 (root causes and what the customer hears), §5.2 (write safety on the customer's site), §5.4 (change sets); `../build-plan.md` Phase 3; the pilot rules (setting and data fixes: a senior approves, never automatic). **Built on:** helpdesk `tbo-copilot` (Phase 2), helpdesk_client `tbo-copilot`, the worker's fix stage (a pull request).

## Goal

When the cause of a ticket is a wrong setting or wrong data, Copilot prepares the exact correction: a **change set** listing each record, the old value and the new value. The customer's site checks it without saving, a **senior** approves it on the ticket, and the hub applies it through the connector. Every change is written in the customer site's own log and on the record's timeline, and the old values are kept, so **Undo** can put them back. When a bug damaged the data, the code fix goes first (Phases 1d and 2), and the data correction runs once the fix is live, under the same one approval.

## What exists today, and what it means for this phase

| Found (13 Oct) | Consequence |
|---|---|
| The router sends `wrong_setting` and `data_damaged_by_bug` to Preparing Fix, which makes a fix task for a developer (a code change). `customer_mistake` gets an explanation only | Phase 3 adds the change set for wrong settings and damaged data, and a correction for customer mistakes when an agent asks for one |
| The worker's report proposes code only: `proposal {action, files, risk, notes}` | The report gains `change_set`, and the worker's instructions say when and how to prepare one |
| The worker already reads the customer's data through the hub (`get_doc`, `get_list`, `get_count`, `get_meta`, `get_version_history`) | Enough to find every affected record; no new read tool |
| The connector's write tools (`set_value`, `set_values`, `create_doc`, `delete_doc`, submit and cancel) run as the support user on the customer's site, and `set_values` with a table replaces the whole table | Before Copilot writes anything, the customer's site must check every write itself (C7): a write list per doctype, a list of things never written, a signed approval from the hub, and its own log |
| The hub has an older write path from the AI support sessions (HDS Support Action Request: an agent approves each proposed call and the hub runs it). It keeps no old values, has no senior rule and does not check whether the record changed since | Copilot gets its own change set with those. The older path keeps working, inside the same guard (decision 9) |
| Approvals (1d) are one per pull request commit, with a payload hash, the senior rule, first decision wins, and reminders | An approval can now be for a change set, or for code and data together; the hash covers the records and their old and new values |
| Deploys (2): Merged → Deploying → Verifying → Resolved | For code and data, the correction runs after the check passes (or after Mark deployed), before Resolved |
| The sandbox copy (1c-2, W3) waits for the server | Its dry run of a change set comes with it; until then the customer's site checks the change without saving and without running its own code |
| Frappe keeps a Version row only for doctypes that track changes (most transactions and masters, not all settings) | The customer site's own change log records every write, and each record gets a note on its timeline |

## Decisions in this plan (please confirm)

| # | Topic | This plan | Why |
|---|---|---|---|
| 1 | What Copilot may change | Values of existing records: settings, setup records (company, accounts, price lists), masters and drafts; a missing table row (for example a company's account on a Mode of Payment); a missing record (for example an Item Price). Up to 1,000 records per change set. **Never** deletes, custom fields, property setters, scripts, workflows, print formats, permissions, users, system or email settings, or integration keys | Those are code or security: they go into the customer's app (Phase 1d) or to a person. A bigger correction is a data patch in the customer's app, reviewed and tested like code |
| 2 | Who approves | A **senior approver**, for every change set in the pilot. Code and data together: one approval, by a senior | The pilot rule. Data has no GitHub review behind it |
| 3 | Submitted documents | Copilot **does not change** submitted invoices, payments or stock entries in the pilot. The change set lists them with the ERP way (cancel and amend, or a return or credit note where e-invoicing forbids cancelling), and a person does it | They move ledgers and stock, may already be reported to ZATCA, and other documents may hang on them. Cancel and amend by the hub can come after the pilot, per doctype |
| 4 | The check before the approval | The customer's site checks every record without saving: the field exists and may change, the value fits, linked records exist, and the record is as Copilot saw it. It returns the old values. The **dry run on the sandbox copy** (which runs the site's own code) is added when the sandbox exists; until then the card says "dry run: not run" | We can build now. The sandbox waits for the server |
| 5 | When it is applied | Right after the senior approves (**Approve and apply**). For code and data, after the deploy's check passes (or Mark deployed). In batches of up to 200 records: each record is read again first and skipped if a field it changes no longer has the old value, and the run stops at the first refusal. **Applied by hand** stays available: the senior applies from the list and the hub reads the records back | A data change needs no build. Reading again first protects people's own edits |
| 6 | The guard on the customer's site | Every write from the hub needs four things: the write switch on; the doctype in the site's **write list** with that action (update, create); never anything on the never list; and on Production a **signed approval** from the hub naming the records (one per batch, valid 2 hours). Each write lands in the site's own **change log** and on the record's timeline. The write list starts empty | The site checks every write itself, whatever the hub says |
| 7 | Undo | **Undo the change** prepares the reverse change set from the stored old values, which goes through the same senior approval. An added record or table row is listed for a person to remove | The same safe road back |
| 8 | Customer mistakes | Copilot explains the ERP way, as today. It prepares a correction only when an agent asks (**Let Copilot prepare the correction**), within decision 1 | Customers usually correct their own entries; TBO does it when asked |
| 9 | The older write path | On a site with the guard, the hub signs the AI support sessions' action requests when an agent approves them; the write list limits them as it limits Copilot | They keep working, inside the same guard |

## What you will see at the end (the demo, on the local pair)

1. **A wrong setting.** A seeded ticket on customer.localhost: a setting on the customer's site is wrong. Copilot finds the setting, and the card shows one record with its old and new value, checked by the site. The senior presses **Approve and apply**. The setting changes. customer.localhost's change log shows who approved it and the old and new value, and the settings form's timeline has the note. The customer's ticket says Resolved, with the note the senior approved.
2. **Data on several records.** Five records hold a wrong value. The card lists all five with the old and new values. After the approval, a user edits one of them on customer.localhost before the apply. That one is skipped and listed, and the other four are corrected.
3. **A submitted invoice** among the wrong records is not touched: the card lists it with the steps for a person.
4. **The guard refuses** a write without the hub's signed approval, a doctype not on the write list, a User record (never), and an approval that has expired.
5. **Undo the change** restores the old values through the same approval.
6. **Code and data together.** The fixture app's seeded bug saved wrong values. The pull request and the change set go on one approval by a senior. After the merge, Mark deployed (the local pair is not on Press) applies the data correction, and the run is Resolved.

## What changes, PR by PR

### C7 (helpdesk_client): the guard on the customer's site (≈ 3 days)

| Item | Detail |
|---|---|
| Settings (HDS Support Settings) | **Site environment** (Production, UAT, Sandbox; Production by default). **Write list** (child HDS Allowed Write DocType: doctype, may update, may create). The **approval key** (Password), set by the hub at pairing; pairs made before get it once from the hub |
| `mcp/write_guard.py` | `check_write_access(doctype, action, approval)`, in this order: support enabled → the write switch → not blocked → on the write list with the action → not on the never list → on Production, the signed approval (HMAC-SHA256 with the approval key, compared with `hmac.compare_digest`; not expired; naming this record and action). **Every** write tool goes through it, including the existing `set_value`, `set_values`, `create_doc`, `delete_doc` and submit/cancel |
| The never list | User, Role, Has Role, DocPerm, Custom DocPerm, User Permission, Role Profile, System Settings, Email Account, Email Domain, OAuth Client, Social Login Key, Connected App, Token Cache, Server Script, Client Script, Scheduled Job Type, Custom Field, Property Setter, Workflow, Print Format, Bulk Update, Data Import, HDS Support Settings, HDS Change Log |
| New tools | `check_change(change)` checks one record's change without saving (fields, values, links, docstatus) and returns its current values. `apply_change(change, approval)` reads the record again and refuses if a field it changes no longer has the old value. Otherwise it applies the change (fields; a table row by its row name; a new table row; a new record), saves with the site's normal validation, writes the change log row and the timeline note, and returns the old and new values |
| **HDS Change Log** | One row per write from the hub: ticket, change set, approved by and at, environment, action, doctype, record, old and new values, status, error, time taken. Only the connector creates rows; the site's System Managers can read them |
| Pairing | The hub's approval key travels with the pairing; `set_approval_key` (POST, support user only) serves pairs made before |
| Patches | Site environment Production; the write list empty. MCP writes stop on a site until its write list is filled, so the team must know before C7 is installed on customer sites |
| Tests | Each refusal (switch, list, action, never list, no approval, a wrong signature, expired, another record); check and apply on a test record; a changed record refused; the change log and the timeline note |

### H13 (helpdesk): change sets, the check, the senior's approval and applying (≈ 4 days)

| Item | Detail |
|---|---|
| **HDS Copilot Change Set** (`TBO-CHG-.YYYY.-.#####`) | Fields: run, ticket, kind (Config Change, Data Fix), status (Prepared, Checked, Approved, Applying, Applied, Stopped, Superseded, Undone), summary, the note for the customer, how the records were found, risk. **Items** (HDS Copilot Change Item): action (set, add row, create), doctype, record, new values, old values (from the check), the check's result, the apply's result, batch. Also: applied by and at, undo of |
| The worker's report | `submit_investigation` accepts `change_set`: the records with their new values, why, and how they were found. It is checked: at most 1,000 records, allowed actions only, nothing on the never list. A shadow run's change set is shown on the card, never approved |
| `copilot/changes.py` | `from_report`; `check` (the site's `check_change` per record; submitted documents and refusals are set aside for a person); `apply` (one signed approval per batch of 200, `apply_change` per record, stop at the first refusal, read back); `undo` |
| `copilot/approval_key.py` | The approval key per connection (Password on HDS Support Connection) and the signing; sent to the site at pairing, and once to the pairs made before |
| Approvals | Kinds: Code Change, Config Change, Data Fix, Code + Data. The payload hash covers the change set's records with their old and new values, and the customer's note. Settings and data always need a senior. A new check with different old values supersedes the approval |
| Run | A new state, **Applying**. Approved → Applying → Resolved (settings, data). Verifying, or Merged with Mark deployed → Applying → Resolved (code and data). Applying → Escalated when it stops |
| Router | `wrong_setting` and `data_damaged_by_bug` with a change set go to the check, then the approval. Without one, as today (the fix task) |
| Card | The change set: summary, risk, the first 20 records with old → new, all of them as a CSV, and the check. **Approve and apply** / **Reject** (with a reason). Afterwards: applied, skipped and refused, plus **Applied by hand** |
| The customer | "Working on it" while it is prepared; "Resolved" with the approved note once it is applied; Confirm or Reopen as before |
| Tests | `test_copilot_changes.py` with a fake customer site: the report's checks, the site's check, the senior rule, the hash, apply in batches, a changed record skipped, stop at a refusal, applied by hand, shadow runs |

### H14 (helpdesk): code and data together, Undo, the older write path, docs (≈ 2 days)

| Item | Detail |
|---|---|
| Code and data | The pull request's approval carries the change set: one approval, by a senior. After the deploy's check (or Mark deployed), the change set is checked again and applied. Records damaged after Copilot looked (before the fix went live) are found again with the same search, and go to a second, small approval |
| Undo the change | The reverse change set from the old values, with the same approval |
| Customer mistakes | **Let Copilot prepare the correction** (agents): a follow-up job asks the worker for the change set |
| The older write path | `approval.execute_approved_actions` signs its approved actions for sites with the guard |
| Docs | `docs/tbo-copilot.md`: change sets, the guard, applying, Undo, and a runbook for a correction that went wrong |
| Tests | Code and data end to end (fake Press, fake site); Undo; the older path signed |

### W6 (worker, fork): Copilot prepares the change set (≈ 2 days)

| Item | Detail |
|---|---|
| Instructions | When the cause is a setting or data: find every affected record with the read tools, reading only the names and the fields needed. Give the new values and why, and say how the records were found. List submitted documents for a person; never change them |
| Report | `change_set` in `submit_investigation`; the refresh job (search again after the deploy) |
| Dry run | The sandbox runner gets "try the change set on the copy", built against the fake runner. It becomes real with W3 |
| Tests | Unit (the report's shape, the limits); one run with a scripted model |

## Out of scope (later)

- Deletes, and changes to submitted documents (cancel and amend by the hub after the pilot, per doctype).
- Custom fields, property setters, scripts, workflows, print formats and permissions: these go as code in the customer's app, or to a person.
- Corrections without a senior, and automatic corrections.
- More than 1,000 records: a data patch in the customer's app.
- Undo of added records or rows (listed for a person).
- Trying corrections on a UAT site first for the customer's acceptance (Press UAT, later).

## How it is built and tested

- helpdesk_client `tbo-copilot`: C7 with module tests on customer.localhost (`hold_commits`; the site's existing write switch and lists are restored after each test).
- helpdesk `tbo-copilot`: H13 and H14 with module tests on tbo.localhost and a fake customer site; leftovers checked after each batch.
- The worker fork: W6 with unit tests and one scripted-model run.
- The demo writes to customer.localhost only to the demo records, with the write switch on and a write list of just the demo doctypes. It is set back afterwards.

## Checkpoint (demo on the local pair)

1. A wrong setting: checked, approved by a senior, applied; visible in customer.localhost's change log, on the record's timeline and in its history; the customer sees Resolved.
2. Several records: one changed in between is skipped and reported; the others are corrected.
3. A submitted document is listed for a person and not touched.
4. The guard refuses: no approval, not on the write list, the never list, an expired approval.
5. Undo restores the old values.
6. Code and data: one approval; the data is applied after Mark deployed.

## Risks

- **A wrong correction on many records.** A senior approves it, after reading each record with its old and new value. At most 1,000 records; the apply stops at the first refusal; Undo uses the stored old values.
- **The site's own code refuses at apply time** (a custom validation). The check before the approval does not run the site's code. The apply stops at the first refusal, and what was not applied stays as it was. The sandbox dry run (when it exists) catches this earlier.
- **Someone edits a record between the approval and the apply.** Each field's old value is compared first; a changed record is skipped and listed, never overwritten.
- **A write the customer's site did not expect.** The guard checks every write on the site itself, the existing write tools included, and the write list starts empty.
- **The approval key.** One per connection, kept on the hub (Password) and the site, and replaced with the connection's keys.
- **Customer data in the AI.** Finding every affected record reads data. The worker reads only names and the fields needed, list sizes are capped, and the same data rules as the investigation apply.
- **Existing sites stop writing when C7 arrives** (empty write list). The team must be told before C7 is installed on customer sites, and the write lists filled where writes are used.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| Senior approvers in HDS Copilot Settings (Administrator on the local pair; the real seniors for the pilot) | H13 | before the demo |
| For each pilot customer: the write list on their site (which doctypes may be changed, and how), and the customer's agreement that TBO may correct their settings and data after a senior's approval | live use | before the first real correction |
| Whether the team still uses the AI support sessions' write requests on customer sites (they stop on a site with the guard until its write list is filled) | C7 rollout | before C7 goes to customer sites |
| On the local pair: customer.localhost's write switch on for the demo, with a write list of only the demo doctypes | the demo | at the checkpoint |
| A Moonshot top-up (the worker prepares the change sets) | W6 and the demo | before the demo |

## As built (13 Oct 2026)

**Commits (local, not pushed yet).** helpdesk_client `tbo-copilot` (C7); helpdesk `tbo-copilot` (H13) and the H14 commit; the worker fork, a branch (W6).

**C7, the guard on the customer's site** (helpdesk_client): `mcp/write_guard.py` checks every write from the hub in this order: support enabled, the write switch, not blocked, a table row judged by its record, the never list, the **Write List** (HDS Allowed Write DocType: may update, may create, may submit and cancel), and on Production the signed approval (HMAC-SHA256 under the site's approval key; the record, the action, the change item and the digest of its exact new and old values; not expired). The existing write tools all go through it. New tools `check_change` and `apply_change`; **HDS Change Log** for every write, applied, refused or failed; a timeline note on each record; capability `write_guard_v1`; patch: site environment Production. Tests: `test_write_guard` 21, `test_mcp_security` updated; customer.localhost left as it was (settings, pairing fingerprint, counts).

**H13, change sets** (helpdesk): `copilot/changes.py`, `copilot/approval_key.py`, HDS Copilot Change Set and Change Item, approval kinds and the run's Applying state, the router, the card's review window (records old → new, set aside, CSV), `change_set_applied_by_hand`, `download_change_set`, the worker's `submit_investigation(change_set)`, the approval key kept at `pair_client`. Tests: `test_copilot_changes` (with a fake customer site that checks the hub's signature), pairing, the worker's MCP report.

**H14, code and data, Undo, mistakes, the older path:** a damaged-data change set rides on the pull request's approval (kind Code + Data, a senior's), and is applied after the deploy's check (Press) or Mark deployed; a pending code approval is reopened when its data correction arrives later. **Undo the change** starts a revert run with the reverse change set. **Let Copilot prepare the correction** starts a follow-up run for a customer's mistake after the explanation was sent. The older Action Request path signs its approved actions. The worker's context gets `prepare_correction` and the ticket's earlier corrections. Docs: `docs/tbo-copilot.md` (corrections, the guard, Undo, runbook). Tests: 23 in `test_copilot_changes` (incl. code and data through Mark deployed and through Press), `test_approval_lock` +1; the other Copilot, GitHub and pairing modules pass unchanged.

**W6, the worker:** the report's `change_set` (schema and the same checks as the hub), the instructions (Corrections), the first message naming an agent's request and earlier corrections, and the sandbox client's `try_change_set` (against the fake runner). 94 worker tests pass.

**Where it differs from the plan**

| Plan | As built | Why |
|---|---|---|
| `set_approval_key`, called by the hub with its support key, for sites paired before | No such endpoint: the site makes its key at `connect_to_hub` (a System Manager's action) and hands it over with the pairing; a site paired before connects once more | A key the hub's own API key could set would let a stolen support key sign its own approvals |
| The approval names the records | It also binds each record's exact new and old values (a digest) and its change item; a created record is created once | A bug on the hub cannot send other values under a valid approval, and a retried call cannot create twice |
| Write list: update, create | Also "may submit and cancel" (off by default) | The older Action Request path can submit or cancel; Copilot's corrections never do |
| Records damaged after Copilot looked "found again with the same search" | The worker's context lists the ticket's earlier corrections; starting Copilot again on the ticket prepares only what they missed, under its own approval | No new worker job kind; the worker sees what was already corrected |
| The dry run on the sandbox copy | The runner's client has `try_change_set`; nothing calls it until W3 gives investigations a copy of the site | Investigations have no sandbox yet; the card says "not run" until then |
| Deletes refused | Refused on every site with the guard, for the older path too | No write list action allows a delete |

**To know before C7 goes to customer sites:** the write list starts empty, so MCP writes stop on a site until its System Manager fills it; the older AI support sessions' write requests stop too on such a site.

## Demo steps (ready; run after the owner's OK)

**Prepare customer.localhost** (the owner's OK needed; set back afterwards):
1. Reconnect it, so it makes its approval key: on the hub `create_pairing_code` for TBO-CONN-2026-#####, then on customer.localhost `connect_to_hub(code, hub_url=http://tbo.localhost:8002)` (keeps the same connection).
2. HDS Support Settings on customer.localhost: Allow Write Operations on; Write List: the demo's settings doctype (update) and the demo records' doctype (update, create). Site environment stays Production, so every write needs the signed approval.
3. Seed the demo: the demo setting set to a wrong value; five demo records at a known wrong value.

**Run it:**
4. Raise a ticket on customer.localhost describing what the wrong setting does; it reaches the hub.
5. The stand-in worker reports the cause and the correction (no AI needed):
   `bench --site tbo.localhost execute helpdesk.test_utils.run_fake_worker --kwargs "{'category': 'wrong_setting', 'ticket': '<ticket>', 'change_set': {'summary': '<what is wrong>', 'customer_note': '<what changes for the customer>', 'found_by': '<the settings doctype>', 'changes': [{'doctype': '<the settings doctype>', 'name': '<the settings doctype>', 'values': {'<field>': '<the right value>'}}]}}"`
6. On the hub ticket, as Administrator (the senior): Copilot → Review correction → Approve and apply. On customer.localhost: the setting changes; HDS Change Log has the row (approved by, old → new); the settings' timeline has the note; the ticket says Resolved.
7. Several records: the same with the five demo records; one is edited on customer.localhost after the check → skipped, the other four corrected.
8. The guard: a write without the signed approval, a doctype not on the list, and a User record are refused (each a Refused row in HDS Change Log).
9. Undo the change → the reverse is approved → the old value is back.

**Set back:** the write switch off and the write list emptied on customer.localhost; the demo records removed; counts compared with before.

