# Phase 0: Groundwork and fixes

**Status:** approved 8 Oct 2026. Built locally, not pushed: C1 `7b091bb`, C2 `4eeceba` (helpdesk_client `feature/c1-security-quick-wins`); H1a `da6cef9` + `a0bdd3a`, H1b `e0af424` (helpdesk `feature/phase0-hub-fixes`). Seed tickets and the evaluation list written (F). Left: the owner enters the two AI keys and names the OpenAI model (E), real ticket numbers for the evaluation list (F), checkpoint 5, task numbers, push. **Estimate:** about 7 developer-days. **Design reference:** `../system-design.md` §5.1 (fixes table), §5.2 (security fixes), §5.5 (models); `../build-plan.md` Phase 0.

## Goal

Make the existing customer ↔ hub link reliable and safe before Copilot builds on it, set the AI providers with a fallback, and start the evaluation set. Nothing new is built for the customer yet; after this phase the current support flow simply works correctly.

## What changes

### A. `tbocloud/helpdesk` (hub), PR H1a: sync and approval fixes

| File | Change | Why |
|---|---|---|
| `helpdesk/ticket_puller.py:241-250` `_push_back` | Raise when the MCP result has `isError`; log once per ticket per hour, not every minute | Refused write-backs are counted as success today, so the customer's ticket stays "Pending" forever |
| `helpdesk/ticket_puller.py:522-534` `sync_conversations` | Append a reply to `state["hub"]` only when the client accepted it | Replies are marked sent when they were refused |
| `helpdesk/ticket_puller.py:348-401` `push_ticket_statuses` | Push only tickets whose status/priority changed since the last push (new hidden field `custom_client_push_hash` on HD Ticket via `setup/install.py get_custom_fields()`); map hub labels the client cannot accept (Waiting on Task, Waiting on Customer, On Hold → Paused; unknown → skip the status, still push `ticket_id`) | 200 unchanged tickets every 5 minutes; whole updates refused because of one label |
| `helpdesk/ticket_puller.py:579` | Close through the controller (`doc.status = "Closed"; doc.save(ignore_permissions=True)`) | Raw `db.set_value` skips status category, SLA and hooks |
| `helpdesk/ticket_puller.py` `pull_connection` (added while building) | One pull per customer site at a time (Redis lock `hds_pull_lock:<connection>`, 5 minutes at most); a pull queued by the site's ping runs as the automation user instead of Guest | The ping and the scheduled pull started in the same minute and imported every ticket twice (seen on the local pair: 8 tickets became 16); the ping path ran as Guest and failed on the first permission check, so it never worked |
| `helpdesk/approval.py:84-107, 134-183` | `frappe.db.get_value(..., for_update=True)`; refuse unless Pending; execute once | A double click could execute a customer write twice |
| `helpdesk/api/support_hub.py` | A permission check on a read endpoint | Details stay private until deployed |
| `helpdesk/setup/install.py:470-475` | Triage status options add `In Progress`, `Skipped` | The code writes values the field does not allow |
| `helpdesk/fix_brief.py:205-212` | Reference line becomes `Closes TASK-YYYY-NNNNN` when the ticket has a task; otherwise keep the ticket number and say a task is needed | PRs that follow the brief are never linked and fail the task-reference check |
| `helpdesk/api/work.py:578-669` `create_task_from_ticket` | New typed parameter `pause_ticket: bool = True` (True keeps today's behaviour) | Copilot runs will create tasks without pausing the SLA |
| `helpdesk/tests/test_client_sync_fixes.py` (new, 12), `test_approval_lock.py` (new, 2), `test_task_from_ticket_pause.py` (new, 2), `test_fix_brief.py` (+1) | Tests with `hold_commits`; fake `MCPClient` as in `test_triage_investigation.py` | Repo rule |
| `docs/` | Note the push-hash behaviour and label mapping in the existing sync doc | AGENTS.md: spec in the same PR |

### B. `tbocloud/helpdesk`, PR H1b: AI provider fallback

| File | Change |
|---|---|
| `helpdesk/helpdesk/doctype/hds_hub_settings/hds_hub_settings.json` | New fields: `fallback_provider` (same options as `ai_provider`), `fallback_base_url`, `fallback_api_key` (Password), `fallback_triage_model`, `fallback_reply_model` |
| `helpdesk/ai_engine.py` `get_provider_config` / `call_haiku` | Return primary and fallback configs; on 401/402/429/5xx or timeout from the primary, retry once with the fallback; `log_usage` records the model that answered; a daily Error Log if the fallback was used more than N times (so the owner notices the primary is failing) |
| `helpdesk/tests/test_ai_engine_fallback.py` (5) | Fake clients: primary fails → fallback answers; both fail → the original error |

### C and D. `tbocloud/helpdesk_client` (customer side), PRs C1 and C2: security hardening

A set of hardening changes to the customer-site app: how the hub authenticates, which endpoints accept which requests, private uploads, the lifecycle of the hub's keys, and what is logged. The changes, files and tests are listed in the private notes; the detailed list stays private until every customer site runs the fixed version.

### E. Configuration (no code)

1. Hub `HDS Hub Settings`: provider **OpenAI Compatible**, base URL `https://api.moonshot.ai/v1`, triage model `kimi-k2.6`; fallback: OpenAI, `https://api.openai.com/v1`, model `gpt-5.x` (the exact ID to confirm). The owner enters the keys in the UI; keys never go through chat.
2. Local pair: keep `allow_write_operations` on for customer.localhost until Phase 1a's `hub_api` replaces it.

### F. Evaluation set (start only)

An evaluation set, kept private: 17 cases from merged pull requests in customer apps (11 bug fixes, 6 customizations), each with a customer-style ticket text and the expected root cause, plus 8 seed tickets on the local customer site, one per root-cause type. The seeded-bug fixture app comes in Phase 1c.

## Out of scope

`hub_api`, stages and the customer UI (Phase 1a); the hub MCP server (1b); the worker (1c); approvals (1d).

## How it is built and tested

- `helpdesk` and `helpdesk_client` are developed on feature branches **inside the running bench** (`~/frappe-bench/apps/<app>`), one branch per PR cut from the latest `main` (`git fetch upstream main`), so `tbo.localhost` and `customer.localhost` run the code under test. After schema changes: `bench --site tbo.localhost migrate` / `bench --site customer.localhost migrate`.
- Tests: `bench --site tbo.localhost run-tests --app helpdesk --module helpdesk.tests.test_<x>`; `bench --site customer.localhost run-tests --app helpdesk_client`. (Confirm `allow_tests` on the local sites first.)
- Pushed only when the owner says so, and only to the `tbo-copilot` branch of each repo, never to `main` (owner, 9 Oct 2026; see `../build-plan.md` §10). No pull requests to `main`; task numbers are not needed for this branch.

## Checkpoint (demo on the local pair)

1. Raise a ticket on customer.localhost → the hub ticket number and **Open** appear on the customer ticket within a minute, once, even when the ping and the scheduled pull run together; reply from the hub → it appears on the customer ticket within 5 minutes; a second status push sends nothing (hash unchanged).
2. The C1 and C2 security checks pass on the local customer site (listed in the private notes).
3. Two concurrent approvals of the same action request: the second is refused.
4. Triage on `tbo.localhost` runs on Kimi; with an invalid Kimi key, the same triage runs on OpenAI and the usage log shows the OpenAI model.
5. The evaluation set has 17 cases from real pull requests and the 8 seed tickets (kept private); done, real ticket numbers pending.

## Risks

- All of these files are the helpdesk maintainer's daily work: keep the PRs small, one feature each, and agree the order with them first.
- The label mapping must match the client's Select exactly (Pending/Open/Replied/Paused/Resolved/Closed).
