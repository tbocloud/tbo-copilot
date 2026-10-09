# Phase 1a: Hub foundation + customer stages

**Status:** approved 8 Oct 2026 (with the seven decisions below); **built locally and the checkpoint passed on the pair on 9 Oct 2026**; not pushed (see "As built" at the end). **Estimate:** about 12 developer-days, six pull requests. **Design reference:** `../system-design.md` §4 (root cause → path, stage messages), §5.1 (hub), §5.2 (customer side); `../build-plan.md` Phase 1a. **Built on:** the Phase 0 branches (not merged yet; see "How it is built").

## Goal

Give Copilot a place to live on the hub and a voice on the customer's side, before any AI runs. After this phase:

- Every ticket from a Copilot-enabled customer gets a **run** on the hub (`HDS Copilot Run`) that a worker can claim, keep alive and report to.
- The hub's **router** turns the worker's investigation into the right path: an explanation for the agent to send, a fix to prepare (stops there until Phase 1c/1d), a hand-over to a person, or a question to the customer.
- The customer sees **stages** on their own ticket in their ERPNext (Received, Working on it, Resolved, With our team, Waiting for you), a timeline of updates, and can press **Confirm, it's fixed** or **Still broken, reopen**.
- The hub talks to the customer site through a new `hub_api`, so the ticket conversation no longer depends on the site's global write switch.

The worker in this phase is a **fake worker** (a `bench execute` script) that reports a chosen root cause; the real worker comes in Phase 1c. No AI call is made in 1a.

## What you will see at the end (the demo on customer.localhost ↔ tbo.localhost)

1. Tick **Copilot enabled** on the pilot customer. Raise a ticket on customer.localhost → within a minute the customer ticket shows the TBO number, status Open and the stage **Received**; the hub ticket shows a run `TBO-RUN-2026-00001` in state Queued.
2. Run the fake worker: it claims the run → the customer ticket shows **Working on it**.
3. The fake worker reports `question` → the hub ticket's suggested-reply card shows the explanation; the agent presses "Use reply" and sends → the reply appears on the customer ticket, stage **Resolved**, with the two buttons.
4. The customer presses **Confirm, it's fixed** → the hub ticket closes, the run closes. Or **Still broken, reopen** with a note → the hub ticket reopens, the run is Escalated, a Task is created for the pilot customer's developer, stage **With our team**.
5. Repeat with `bug` (the run stops at Preparing Fix, stage Working on it, the root cause on the ticket), `core_issue` (Task + With our team), `unclear` (the question in the card → Waiting for you; the customer's reply starts a follow-up run).
6. Kill the fake worker mid-run → five minutes later the run is back in Queued (lease expired); after three lost leases it fails and a person is told.

## Decisions in this plan that differ from the design (please confirm)

| # | The design said | This plan | Why |
|---|---|---|---|
| 1 | H2 includes `press.py` reads and `registry.sync_from_press` | The registry doctype and lookups are built now; sites are entered by hand for the pilot; `press.py` moves to Phase 2 | No Press API user exists yet (§6), and Phase 2 verifies the Press API anyway |
| 2 | Stage messages are also inserted as Sent Communications (email, Chatwoot) | On connected sites a stage goes to the customer's own ticket (`hub_api`) and is recorded on the hub as an internal comment; no email per stage in 1a | The hub has no outgoing email locally, and the conversation sync would deliver the same text a second time as a comment; email for non-connected customers comes with Phase 4 |
| 3 | Names `CPR-…`, `CPS-…` | `TBO-RUN-.YYYY.-.#####`, `TBO-SITE-.YYYY.-.#####` | Every HDS doctype in the repo is named `TBO-<KIND>-…`; the helpdesk maintainer reviews these PRs |
| 4 | HDS Copilot Settings has three child tables (model map, approvers, templates) | Only the message templates now; the model map comes with the worker (1c), approvers with approvals (1d) | Repo guardrail: no unused fields |
| 5 | Two stage vocabularies (§4 hub names, §5.2 client labels) | One list everywhere: Received, Working on it, Fix scheduled, Resolved, With our team, Waiting for you | One vocabulary, one Select |
| 6 | Client visibility: role All `if_owner` + hooks | Role **All** read without `if_owner`, plus the query hook and a `has_permission` hook that allow owner OR raised_by | With `if_owner` Frappe adds `owner = user` itself and ANDs the hook, so "or raised_by" is impossible |
| 7 | Agent UI: a header button + dialog on the ticket page | The same, built as a second HD Form Script ("Helpdesk Copilot Actions") that composes with the existing AI one | The repo rule says in-app pages and dialogs, not `/app` desk forms; form scripts already compose |

## What changes, PR by PR

Order: H2 → H3 → H6a → H6b on the hub; C3 → C4 on the customer side. The two sides can be built in parallel; the checkpoint needs all six.

### H2 (helpdesk): Copilot settings + site registry (≈ 1.5 days)

| Item | Detail |
|---|---|
| `HDS Copilot Settings` (Single) | `enabled` (Check), `lease_minutes` (Int, 5), `max_lease_losses` (Int, 3), `min_confidence` (Float, 0.6), `handover_project` (Link Project, used when the customer has no project), `message_templates` (Table → `HDS Copilot Message Template`: `stage` Select, `message` Small Text). `validate` seeds the six default templates when the table is empty (the HD File Storage Settings pattern). Permissions: System Manager; Agent Manager read |
| `HDS Site Registry` (`TBO-SITE-.YYYY.-.#####`, title `customer_name`) | `customer_name` (Link HD Customer, reqd), `environment` (Select Production/UAT/Sandbox, reqd), `connection` (Link HDS Support Connection), `site_url` (Data), `press_site`, `press_release_group` (Data, filled in Phase 2), `shared_group` (Check), `apps` (Table → `HDS Site App`: `app` Data reqd, `repository` Data `org/repo`, `branch` Data, `deployed_commit` Data, `drift_status` Select Unknown/In sync/Drift), `last_synced` (Datetime). One Production row per customer and connection (validate). Permissions: System Manager; Agent, Agent Manager read |
| `helpdesk/copilot/__init__.py`, `settings.py` | `get_settings()`, `is_enabled()`, `template_for(stage) -> str` |
| `helpdesk/copilot/registry.py` | `registry_for_ticket(ticket)` (by the ticket's connection, else the customer's Production row, else None), `apps_for(registry) -> list[dict]` |
| `setup/install.py get_custom_fields()` | HD Customer: `custom_copilot_enabled` (Check), `custom_assigned_developer` (Link User) |
| `docs/tbo-copilot.md` (new) | The hub spec: parts, doctypes, settings; grows with every Copilot PR |
| Tests | `tests/test_copilot_settings.py`, `tests/test_site_registry.py`; helpers `make_copilot_settings`, `make_site_registry` in `test_utils.py` |

### H3 (helpdesk): runs, events, leases, worker API (≈ 3 days)

| Item | Detail |
|---|---|
| `HDS Copilot Run` (`TBO-RUN-.YYYY.-.#####`) | `ticket` (Link HD Ticket, reqd), `customer`, `connection`, `registry`, `kind` (Select investigate/followup; later code/config/data/revert), `state` (Select, the list below), `worker_id`, `lease_token` (Password), `lease_expires` (Datetime), `lease_losses` (Int), `root_cause_category` (Select, the 8 values), `confidence` (Float), `investigation`, `proposal`, `evidence` (JSON), `customer_message` (Small Text), `handed_over_to` (Link User), `task` (Link Task), `failure_reason` (Small Text), `cost_usd` (Currency), `queued_at`, `claimed_at`, `investigated_at`, `finished_at`. Permissions: System Manager full; Agent, Agent Manager read; **Copilot Worker** read (the role is created by this permission row and ensured in `after_migrate`) |
| `HDS Copilot Event` | `run` (Link), `seq` (Int), `event_key` (Data, unique, `run:seq`), `event_type` (Data: state_change, lease, lease_expired, tool_call, note, …), `actor` (Data), `payload` (JSON, cut at 16 KB with a `truncated` Check). `in_create`; kept 90 days via `default_log_clearing_doctypes` |
| HD Ticket custom fields | `custom_copilot_run` (Link, the latest run), `custom_copilot_stage` (Data), `custom_root_cause` (Data), `custom_customer_confirmation` (Select ""/Confirmed/Reopened) |
| `helpdesk/copilot/runs.py` | `start_run(ticket, kind="investigate", actor=None)` (one active run per ticket, else returns it; sets `custom_copilot_run`, stage Received, event, realtime); `TRANSITIONS` = `{(from, to): {actors}}`; `transition(run, to, actor, note="", **fields)` (row lock `for_update`, validate, `state_change` event, ticket stage fields, `publish_event("helpdesk:copilot-run", room=doc room, data={"ticket", "run"})` after commit); `claim(worker_id, capabilities)` (oldest Queued, `for_update`, `lease_token = frappe.generate_hash(32)`, `lease_expires = now + lease_minutes`, Investigating); `check_lease(run, token)` (valid and not expired, else `PermissionError`); `heartbeat(run, token)` extends; `expire_stale_leases()` (cron `*/5`: Investigating with an expired lease → `lease_losses += 1` → Queued, or Failed after `max_lease_losses` + `notify_users` to the Agent Manager + stage With our team); `on_ticket_insert(doc, method)` (`after_insert` hook: customer enabled and settings enabled → `start_run`); `run_context(run) -> dict` (ticket, triage fields, customer, registry apps, the last 20 comments and communications, the file list; never credentials) |
| `helpdesk/api/copilot_worker.py` | All `@frappe.whitelist(methods=["POST"])`, typed, role check `"Copilot Worker" in frappe.get_roles()` (not `only_for`, which is skipped in tests), `@rate_limit(limit=600, seconds=60)`: `claim_job(worker_id: str, free_slots: int = 1, capabilities: str = "") -> dict` (`{run, lease_token, lease_expires, context}` or `{}`); `heartbeat(run: str, lease_token: str, stage: str = "") -> dict` (`{ok, action: continue or cancel}`); `post_events(run: str, lease_token: str, events: list or str) -> dict` (insert by `seq`, duplicates ignored, returns `{acked: [seq]}`); `submit_result(run: str, lease_token: str, result: dict or str) -> dict` (`kind: investigation` → `router.route` (H6a; in H3 it stores the investigation and moves the run to Explaining/Preparing Fix/Handed Over by a minimal table); `kind: failure` → Failed + notify) |
| `hooks.py` | HD Ticket `after_insert` += `helpdesk.copilot.runs.on_ticket_insert`; cron `*/5` += `helpdesk.copilot.runs.expire_stale_leases`; `default_log_clearing_doctypes` += HDS Copilot Event 90 |
| `setup/__init__.py after_migrate` | `ensure_role("Copilot Worker", desk_access=0)` (the `content_team.ensure_role` pattern) |
| Tests | `tests/test_copilot_runs.py` (one active run per ticket; allowed and refused transitions; lock; events idempotent by seq and truncated; claim FIFO; lease check; heartbeat; expiry → Queued → Failed after three; realtime published; ticket fields), `tests/test_copilot_worker_api.py` (role required; POST only via `allowed_http_methods_for_whitelisted_func`; wrong token refused; bad result refused); helpers `make_copilot_run`, `run_fake_worker`, `FakeWorker` in `test_utils.py` |

### C3 (helpdesk_client): Support Ticket stages, confirm/reopen, visibility, context (≈ 3 days)

| Item | Detail |
|---|---|
| `Support Ticket` fields (hub-written ones read-only) | `stage` (Select, the six stages), `stage_message` (Small Text), `status_label` (Data, the hub's own label), `handled_by` (Data), `resolution` (Small Text), `deployed_commit` (Data), `deployed_at` (Datetime), `customer_confirmation` (Select ""/Confirmed/Reopened), `confirmation_note` (Small Text), `confirmed_at` (Datetime), `reopen_requested` (Check), `reopen_count` (Int), `page_route` (Data), `ref_doctype` (Data), `ref_docname` (Data), `user_roles` (Small Text), `error_logs` (Long Text), `code_identity` (Long Text), `raised_by_email` (Data), `raised_by_name` (Data), `updates` (Table → `Support Ticket Update`: `hub_ref` Data reqd, `kind` Select Stage/Reply/System, `stage` Data, `message` Small Text, `author_name` Data, `posted_at` Datetime) |
| Permissions | Role **All**: read, no `if_owner`; the Genie User row goes (the role stays, harmless). `get_permission_query_conditions` → `owner = user OR raised_by = user` (System Manager unrestricted); a new `has_permission` hook in `hooks.py` denies everyone else. `request_close` becomes POST-only and accepts owner or raised_by |
| `support_ticket.py` | `confirm_resolution(ticket: str, note: str = "") -> dict` and `reopen(ticket: str, note: str) -> dict`: `methods=["POST"]`; owner, raised_by or System Manager; only when the stage is Resolved or the status Resolved/Closed; saved through `doc.save` so `on_update` runs; `reopen` needs a note and bumps `reopen_count`. The hub reads both through `get_ticket_changes` |
| `utils/support.py create_ticket` | New typed params `page_route: str = ""`, `ref_doctype: str = ""`, `ref_docname: str = ""`; the server fills `user_roles` (`frappe.get_roles()`), `error_logs` (the raiser's own Error Log rows of the last 24 h, at most 10: method + the first 500 chars), `code_identity` (installed apps and versions, cached 10 min; the git commit comes with C6 in Phase 1b), `raised_by_email` / `raised_by_name` (User.email / full_name; `Administrator` → the new setting `fallback_contact_email`) |
| `public/js/support_ticket.js` | Captures `frappe.get_route()` and the open form's doctype and name when the dialog opens; the microphone becomes optional (record the screen without audio when it is denied; stop the display stream on failure; `startRecording`, L579-643) |
| `doctype/support_ticket/support_ticket.js` | Stage banner (`set_intro`, one colour per stage); the updates timeline (newest first, rendered from `updates` into an HTML field); the resolution box when the stage is Resolved and nothing is confirmed: **Confirm, it's fixed** / **Still broken, reopen** (asks for a note); the Close button stays for the other cases; `support_ticket_list.js` shows the stage |
| `HDS Support Settings` | `fallback_contact_email` (Data) |
| Patch `v15_0_4/backfill_raised_by_email` | Fills `raised_by_email` / `raised_by_name` on existing tickets |
| Tests | `tests/test_support_ticket_stages.py` (fields; confirm/reopen by the owner, by raised_by, refused for others, POST only; visibility for owner, raised_by, another user and a System Manager, list and single document; context capture and the email fallback; the patch); `test_support.py` extended; the doctype test's `make_ticket` gets `raised_by` |

### C4 (helpdesk_client): `hub_api` + capabilities (≈ 1.5 days)

New module `helpdesk_client/hub_api.py`; every function is `@frappe.whitelist(methods=["POST"])`, calls `_require_support_user()` first, has typed params, and saves with `ignore_permissions` and `flags.from_hub`. The gate already allows the prefix (`hub_gate.py:21`).

| Endpoint | Behaviour |
|---|---|
| `update_ticket(name: str, values: dict or str) -> dict` | Allow-listed fields: `ticket_id`, `status`, `status_label`, `priority`, `category`, `stage`, `stage_message`, `handled_by`, `resolution`, `deployed_commit`, `deployed_at`. `map_hub_status(label)`: known labels pass; Waiting on Task, Waiting on Customer, On Hold → Paused; unknown → the status is unchanged and the label is kept in `status_label`. Saves only when something changed, so `on_update` → `notify_status_change` runs once. Returns `{ok, applied, ignored}` |
| `add_update(name: str, hub_ref: str, stage: str, message: str, author_name: str = "TBO Support", kind: str = "Stage") -> dict` | Idempotent on `(ticket, hub_ref)`; appends an `updates` row; a Stage row also sets `stage` and `stage_message`; one Notification Log (Alert) to the raiser. Returns `{ok, duplicate}` |
| `post_reply(name: str, hub_ref: str, content: str, author_name: str = "TBO Support") -> dict` | Idempotent on `hub_ref`; creates the Comment as the support user (so `notify_reply` fires as today) plus an `updates` row of kind Reply |
| `get_ticket_changes(since: str, limit: int = 200) -> dict` | Tickets modified since `since`: `name, ticket_id, status, close_requested, customer_confirmation, confirmation_note, confirmed_at, reopen_requested, reopen_count, modified`, plus `server_time` as the next cursor |
| `capabilities() -> dict` | `{client_version, capabilities: ["hub_api_v1"]}`; `register_connection` returns the same keys so the hub learns them at pairing |

Errors use typed exceptions (`PermissionError` 403, `DoesNotExistError` 404, `ValidationError` 417), so the hub's `_call_client` keeps working. Tests: `tests/test_hub_api.py` (support user only; POST only; the allow-list; the mapping; idempotency; the cursor; capabilities).

### H6a (helpdesk): router, customer stages, confirm/reopen, agent dialog (≈ 2.5 days)

| Item | Detail |
|---|---|
| `helpdesk/copilot/router.py` | `validate_investigation(result)` (category among the 8, confidence 0–1, strings bounded); `route(run, investigation)`: confidence below `min_confidence` → treated as `unclear`; then the table below; records `custom_root_cause`, the investigation on the run, and an internal HD Ticket Comment "Copilot diagnosis" by the automation user (summary + evidence) |
| `helpdesk/copilot/customer.py` | `send_stage(ticket, stage, context=None)`: render the template → skip when the ticket already shows that stage with the same text → `hub_api.add_update` with `hub_ref = "<run>:<stage>:<n>"` when the site advertises `hub_api_v1` → an internal comment on the hub → `custom_copilot_stage`. `draft_explanation(run, text)` → `ai_suggestion.store_suggestion(ticket, {reply, note: "From Copilot run …"}, sources=[{kind: investigation, name: run}])`. `on_communication_insert(doc, method)`: Sent on a ticket whose run is Explaining → Answered and the stage Resolved or Waiting for you; Received on a ticket whose run is Answered with stage Waiting for you → `start_run(kind="followup")`. `on_customer_comment(ticket)` does the same for comments synced from the site. `decide_resolution(ticket, confirmed, note, actor)`: Confirmed → the ticket closes through the controller, run Closed, stage Resolved with the note; Reopened → the ticket goes to `ticket_reopen_status`, run Escalated, a Task for `custom_assigned_developer` via `create_task_from_ticket(pause_ticket=False)` as the automation user (project: the customer's first open Project, else `handover_project`), stage With our team, `notify_users` + `post_escalation` |
| `helpdesk/client_api.py` | `call(conn, method: str, payload: dict) -> dict` (the body of `support_hub._call_client`, which becomes a one-line alias), `hub_api(conn, name, payload)`, `supports(conn, capability) -> bool` (reads the new `client_capabilities` on HDS Support Connection) |
| HDS Support Connection | `client_capabilities` (Small Text, JSON list), `client_version` (Data): filled by `_register` from the pairing reply, refreshed by the daily `health_check_connections` (`hub_api.capabilities`; an error means an old client) |
| `helpdesk/api/copilot.py` | `start_run(ticket: str or int) -> dict` (POST, agent_only, write permission); `get_run(ticket) -> dict` (agent_only, read permission: state, root cause, stage, the last 20 events, task, suggestion status); `decide_resolution(ticket: str or int, confirmed: bool or int or str, note: str = "") -> dict` (POST; `check_permission("read")`, then `is_agent() or is_ticket_customer(doc)`: the `decide_estimate` pattern) |
| `hd_form_scripts/copilot_actions.js` + HD Form Script "Helpdesk Copilot Actions" | Actions **Start Copilot** (when no active run) and **Copilot** (a dialog: state, root cause, stage, evidence, events, the task link, Cancel). Installed by the same helper as the AI script; `_create_form_script` takes a list and the duplicate copy in `setup/__init__.py` is removed |
| `desk/src/pages/ticket/CopilotResolutionBanner.vue` | Copied from `EstimateApprovalBanner.vue`; shown on `TicketCustomer.vue` when the stage is Resolved and nothing is confirmed; Confirm / Reopen (with a note) → `decide_resolution`; `vite build` |
| `hooks.py` | Communication `after_insert` += `helpdesk.copilot.customer.on_communication_insert` |
| Tests | `tests/test_copilot_router.py` (each category → state, stage, suggestion, task, comment; low confidence → unclear; a bad result refused), `tests/test_copilot_customer.py` (a stage pushed once; an old client → no hub_api call and no error; Sent → Answered; Received → follow-up run; confirm and reopen effects and permissions for the customer, an agent and a stranger), `tests/test_copilot_form_script.py` (installed, composes with the AI script) |

### H6b (helpdesk): the hub uses `hub_api` when the site advertises it (≈ 1 day)

| Item | Detail |
|---|---|
| `ticket_puller.push_ticket_statuses` | `supports(conn, "hub_api_v1")` → `update_ticket` with the raw hub label as `status_label` and the mapped status; otherwise today's `set_values` |
| `ticket_puller.sync_conversations` | Agent replies → `post_reply(hub_ref = the Communication name)` when supported, else `create_doc` Comment; customer comments → `on_customer_comment`; `get_ticket_changes(since = state["changes_cursor"])` → confirmations and reopens → `customer.decide_resolution(actor = automation user)`; `close_requested` as today |
| `docs/customer-site-sync.md` | The two paths (`hub_api`, MCP) and the capability rule |
| Tests | `tests/test_client_sync_hub_api.py` (the push uses `update_ticket` when advertised and `set_values` otherwise; replies idempotent; the confirmation cursor; capabilities stored at pairing and refreshed daily) |

## The run state machine (Phase 1a)

| From | To | Actor | When |
|---|---|---|---|
| — | Queued | system, agent | a ticket is inserted for a Copilot-enabled customer; Start Copilot; a follow-up after the customer's reply |
| Queued | Investigating | worker | `claim_job` (lease) |
| Investigating | Queued | system | the lease expired (fewer than `max_lease_losses` times) |
| Investigating | Failed | worker, system | `submit_result(failure)`; too many lost leases |
| Investigating | Explaining | system (router) | question, not_allowed_request, customer_mistake, unclear |
| Investigating | Preparing Fix | system (router) | wrong_setting, bug, data_damaged_by_bug (**stops here in 1a**; Phase 1c/1d continue to Awaiting Approval) |
| Investigating | Handed Over | system (router) | core_issue |
| Explaining | Answered | system | the agent sent the reply (Communication Sent) |
| Answered | Closed | customer, agent, system | Confirm |
| Answered, Preparing Fix, Handed Over | Escalated | customer, agent | Reopen; a person takes over |
| any active state | Cancelled | agent | Cancel from the dialog |

Later phases add Awaiting Approval, Approved, Merging, Merged, Deploying, Verifying, Resolved and Rejected. Every transition writes an `HDS Copilot Event`, updates `custom_copilot_stage`, and publishes `helpdesk:copilot-run` (IDs only; the UI re-fetches through permission-checked APIs).

## The router in Phase 1a

| Root cause | Run state | Customer stage | What else |
|---|---|---|---|
| question, not_allowed_request, customer_mistake | Explaining | Working on it → **Resolved** once the agent sends | `customer_message` → the suggested-reply card; the agent sends |
| unclear (or confidence below `min_confidence`) | Explaining | Working on it → **Waiting for you** once sent | the questions → the suggested-reply card; the customer's reply → a follow-up run |
| wrong_setting, bug, data_damaged_by_bug | Preparing Fix | **Working on it** ("we found the cause and are preparing a fix") | `custom_root_cause`; the diagnosis comment; continues in Phase 1c/1d |
| core_issue | Handed Over | **With our team** | a Task for the customer's developer (`custom_assigned_developer`), else the Agent Manager is notified |

The investigation result accepted by `submit_result`: `{kind: "investigation", root_cause_category, confidence, summary, evidence: [{type, ref, note}], proposal: {type, text}, customer_message, questions: [], cost: {tokens, usd}}`.

## Default stage messages (editable in HDS Copilot Settings)

| Stage | Message |
|---|---|
| Received | We have received your ticket and are looking at it. |
| Working on it | We found what is happening and are working on it. We will update you here. |
| Fix scheduled | A fix is ready and will go live on {date}. |
| Resolved | {resolution} Please confirm this solved it, or reopen the ticket if not. |
| With our team | A TBO engineer is looking at this personally. |
| Waiting for you | We need some information from you; please see our reply. |

## Tests, docs, rules

- Hub: `helpdesk/tests/test_copilot_*.py` with `hold_commits`; helpers only in `test_utils.py`; remote calls patched (`client_api.call`, `MCPClient`); `vite build` after the banner; `docs/tbo-copilot.md` and `docs/customer-site-sync.md` updated in the same PRs; typed params, `methods=["POST"]` on writes, explicit permission checks (the CodeRabbit rules).
- Client: `tests/test_support_ticket_stages.py`, `tests/test_hub_api.py`; the scheduler assertion in `test_notifications.py` stays as it is (no new scheduled job on the client).
- The client's status list and the hub's `CLIENT_STATUSES` stay identical.

## Out of scope

AI calls (1c), the hub MCP server (1b), approvals and PR linkage (1d), Press (2), change sets and the approval token (3), email and Chatwoot delivery of stage messages (4), the Vue card on the agent page (4), a per-customer Copilot settings page.

## How it is built and tested

- Hub branches are cut from `feature/phase0-hub-fixes` (H6b needs its status mapping and push hash) until Phase 0 is merged, then rebased on `main`: `feature/phase1a-h2-copilot-settings`, `…-h3-copilot-runs`, `…-h6a-copilot-router`, `…-h6b-hub-api-sync`. Client branches are cut from `feature/c1-security-quick-wins` (the gate's allow-list): `feature/phase1a-c3-ticket-stages`, `…-c4-hub-api`.
- After each schema change: `bench --site tbo.localhost migrate` / `bench --site customer.localhost migrate`; after the banner: `bench build --app helpdesk`.
- Module tests only on the local sites (`run-tests --module …`), never the full suite.
- Pushed only when the owner says so, and only to the `tbo-copilot` branch of each repo, never to `main`; no pull requests to `main` (owner, 9 Oct 2026; see `../build-plan.md` §10).

## Checkpoint (demo on the local pair)

Steps 1–6 of "What you will see". Commands: `bench --site tbo.localhost execute helpdesk.test_utils.run_fake_worker --kwargs "{'category': 'question'}"` claims the oldest queued run and reports that category with a canned explanation; the same with `bug`, `core_issue`, `unclear`; `--kwargs "{'category': 'bug', 'abandon': True}"` claims and exits without reporting, then `bench --site tbo.localhost execute helpdesk.copilot.runs.expire_stale_leases` (or the cron) shows the re-queue.

## Risks

- Every hub PR touches `hooks.py` and `install.py`, the helpdesk maintainer's daily files: minimal lines, one PR at a time, in an agreed order.
- `MCPClient` commits after each audited call: the router and the sync save their state before and after remote calls, as Phase 0 does.
- The customer's ERP must receive the new `helpdesk_client` version (a Press update) before stages show; until then the old push path keeps working.
- The realtime room for a ticket can be joined by anyone who knows the ID: payloads stay ID-only.
- Triage and the Copilot run both start on `after_insert`; the run context includes the triage fields when they exist, and the worker must not depend on them.

## What TBO must provide for this phase

- Nothing new on infrastructure. For the demo: Copilot enabled on the pilot customer, a Project for that customer (or `handover_project`), and a developer in `custom_assigned_developer`.
- Later: the worker VM and keys (1c), the approver rota (1d).

## As built (9 Oct 2026)

| PR | Branch (stacked on the previous one) | Commits | Tests |
|---|---|---|---|
| H2 | helpdesk `feature/phase1a-h2-copilot-settings` (on `feature/phase0-hub-fixes`) | `dd705a2` | `test_copilot_settings` 6, `test_site_registry` 5 |
| H3 | helpdesk `feature/phase1a-h3-copilot-runs` | `dc1a515` | `test_copilot_runs` 15, `test_copilot_worker_api` 6 |
| C3 | helpdesk_client `feature/phase1a-c3-ticket-stages` (on `feature/c1-security-quick-wins`) | `08c06dd` | `test_support_ticket_stages` 11 |
| C4 | helpdesk_client `feature/phase1a-c4-hub-api` | `b60728e` | `test_hub_api` 14 |
| H6a | helpdesk `feature/phase1a-h6a-copilot-router` | `9a7304a` | `test_copilot_customer` 13, `test_copilot_form_scripts` 1 |
| H6b | helpdesk `feature/phase1a-h6b-hub-api-sync` | `5c811b4`, `f83b59c` | `test_client_sync_hub_api` 7 |

**Branch `tbo-copilot` (9 Oct 2026).** The owner decided that Copilot work goes to a branch of its own in each repo, never to `main`. helpdesk: the eight Phase 0 and 1a commits were rebased onto the latest `main` (8816ca6, 14 commits newer than the base they were built on) as `tbo-copilot`: H1a d8ff85d, H1b 349cdfb, pull lock 1b42b98, H2 dc96f38, H3 d16875b, H6a c8f1849, H6b 8457741, fix 7803d4e. One conflict, in `desk/src/pages/ticket/TicketCustomer.vue` (main redesigned the customer page): both additions kept. After the rebase all 14 Copilot and sync test modules pass on tbo.localhost, the frontend builds, and a live ticket went through (SUP-2026-00018 → 0241). Three of main's own modules (`test_task_estimates`, `test_work_control`, `test_task_moves`) fail on this bench because main calls `frappe.desk.form.assign_to._add`, which Frappe 15.84.0 (the bench's version) does not have; they fail the same way on `main` itself. helpdesk_client: `main` had not moved, so `tbo-copilot` is C1–C4 as built (b60728e). Both branches were pushed to tbocloud on 9 Oct 2026 with the owner's go-ahead; no pull request was opened.

Found and fixed while building: the pulled ticket got its connection and client number only after the insert, so the first stage ("Received") could not reach the customer's site (`f83b59c`); `helpdesk/tasky/api.py` used `assign_to._add`, which Frappe 15 does not have, so a task could not be assigned (H6a); the lease token is stored as a sha256 hash, not a Password field; the worker API has no rate limit yet (the MCP server's rate limit in 1b covers the same door); a cancelled run keeps its token so the worker's next heartbeat is answered with `cancel`; a follow-up run keeps the customer's stage ("Waiting for you") until a worker claims it; the customer's confirmations are read per connection from `get_ticket_changes` for every hub_api site, open tickets or not, with the cursor on the connection.

Checkpoint on the pair (customer.localhost ↔ tbo.localhost), all through `bench execute`: question → stages Received, Working on it on the customer ticket → the explanation in the agent's card → the agent's reply delivered → stage Resolved → the customer confirmed on their site → hub ticket and run Closed (0235 / SUP-2026-00012); bug → Preparing Fix (0236); core issue → Handed Over with TASK-2026-00001 in PROJ-0001 and "With our team" (0237); customer's mistake explained, then reopened from the customer's site → Escalated, TASK-2026-00002, "With our team" (0238); unclear → the question sent → "Waiting for you" → the customer's comment started follow-up run TBO-RUN-2026-00006, claimed and routed (0239); a worker that stopped reporting three times → Failed, "With our team" (0240). Settings used: Copilot enabled, the pilot customer "Copilot enabled" with developer Administrator, project PROJ-0001; the connection's capabilities refreshed with `helpdesk.client_api.refresh_capabilities`.

Still to see in the UI: the Copilot button and dialog on the ticket page (HD Form Script "Helpdesk Copilot Actions"), the suggested-reply card with "Use reply", the customer portal banner "Is this solved?", and on customer.localhost the stage banner, the updates timeline and the two buttons on a Support Ticket.
