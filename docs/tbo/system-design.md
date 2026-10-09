# TBO Copilot: system design

The source of truth for the design, approved by the owner on 8 Oct 2026. The build plan with a status per phase is in `build-plan.md`; each phase has its own plan in `phases/`.

## 1. Context

TBO (Team Back Office) supports customers whose ERPNext sites run on TBO's own Press (on AWS). Today a customer's issue is handled by people at every step: read, investigate, fix, test, deploy, reply. The goal is **TBO Copilot**: an AI support engineer that takes a customer issue from the first message to a verified fix, with **one person approving** each change from a short summary.

What the owner asked for (6–8 Oct 2026):
1. A customer raises an issue in their ERPNext; Copilot works on it and keeps the customer informed.
2. If the customer asks for something wrong or not allowed, Copilot explains why and what to do instead.
3. If the problem is on the customer's side (missing data, wrong setting, entry mistake), Copilot explains it kindly and shows the ERP way to fix it.
4. When a code, config or data change is needed, Copilot prepares it; **one human approves**; then it **deploys automatically through Press**, verifies, and tells the customer, who can confirm or reopen.
5. The design may change `tbocloud/helpdesk`, `tbocloud/helpdesk_client` and `tbocloud/tbo-copilot` freely.

What exists already (verified in code this week): TBO Support (`helpdesk`) with tickets, SLA, AI triage, fix brief, AI suggested reply, tasks linked to tickets, GitHub PR sync, Chatwoot, Teams webhooks, customer connections (MCP) to each customer's ERPNext (`helpdesk_client`); a local test pair `customer.localhost` ↔ `tbo.localhost` (connection `TBO-CONN-2026-00001`); the TBO Copilot desktop app (fork of PI-Desktop) with the `tbo.support` plugin (PR #2, read-only ticket tools, tested live).

Decisions taken with the owner on 8 Oct 2026:

| Area | Decision |
|---|---|
| Where the hub code lives | **Inside `helpdesk`**, new package `helpdesk/copilot/` (matches TASK-2026-00013). Small PRs, one feature each, everything in our own folder |
| Automatic "UAT check" in v1 | **Sandbox copy** on the worker: a throwaway site restored from the customer's masked, credential-stripped backup. No Press build until the approved production deploy. Press UAT stays manual (customer acceptance of customizations) |
| AI model | **Kimi k2.6 (Moonshot International) first, OpenAI (GPT-5.x) as automatic fallback** when Kimi fails or runs out. The model is a setting, not code |
| The one approval, v1 | **On the TBO Support ticket page**, plus a **Teams message with a link** (existing webhook). A **Teams bot with buttons is designed but built later** (§6.6) |
| Deploy in the pilot | **Controlled**: after the approval and the sandbox verification, a person presses **Deploy** on the card (night window recommended, one build at a time); Copilot runs the Press deploy and verifies. **Automatic deployment comes later**, only for low-risk categories, after several successful tickets |
| Config and data fixes | **Senior-approved and controlled from the start**: Copilot prepares and dry-runs the change set; a senior approves; the hub applies it with logging, or the senior applies it by hand from the change set. Never automatic in the pilot |
| Build order | **Vertical slice first**: ticket → investigation → diagnosis → sandbox → PR → approval. Press deployment is added once that works reliably. The §5.6 features stay later |

Owner's review of this design (8 Oct 2026): approved to proceed (rated about 8.5/10 for a v1) with the three changes above; no further redesign now.

Principles that never change: the AI never changes a live system alone; one approval per change (a senior approver for accounting, payments, stock, payroll/tax, permissions, migrations, integrations); every change is traceable outside the AI (ticket, Task, GitHub PR, Press deploy, ERP Version history, audit logs); customers install nothing new; the AI sandbox holds no secrets; the "TBO AI" automation user is credited for AI actions; core changes to PI-Desktop stay minimal and are offered upstream.

## 2. The whole system in one picture

```
CUSTOMER                           TBO SUPPORT (helpdesk on tbocloud)                 TBO WORKER (Linux VM)
customer site …                    ┌──────────────────────────────────────┐           ┌─────────────────────────────┐
helpdesk_client                    │ tickets · triage · fix brief · SLA   │ worker API│ supervisor (job loop)        │
 support button ──ticket──────────►│ helpdesk/copilot/                    │◄─────────►│ tbo-worker-host (pi engine   │
 stage/updates ◄──hub_api──────────│  runs · router · approvals · customer│   MCP     │   + MCP relay, auto mode)    │
 MCP reads/approved writes ◄───────│  change sets · deploy · registry     │◄─────────►│ sandbox benches (Docker,     │
                                   │  MCP server (tickets, tasks, KB,     │           │   masked customer copy,      │
                                   │   customer-ERP proxy, worker tools)  │           │   no internet)               │
                                   └───────┬──────────────┬───────────────┘           │ llm-proxy (Kimi → OpenAI)    │
            approve on the ticket ─────────┘              │ Press API (night window)   └──────────┬──────────────────┘
            + Teams link                                  ▼                                       │ branch + PR
TBO PEOPLE: browser · Teams · (optional) TBO Copilot desktop app      PRESS (self-hosted) ◄──── GITHUB (customer apps)
```

A ticket's journey:

```
1 Issue arrives      customer's support button / chat / email → HD Ticket            people: none
2 Triage             first guess: type, priority, SLA, fix brief                     people: none
3 Investigate        worker agent reads ticket, replay, error logs, code at the      people: none
                     deployed commit; finds the ROOT CAUSE → router (§5)
4a Explain           question / not allowed / customer's own mistake → AI draft →    people: one support agent
                     support agent sends (existing suggested-reply card)              sends (~1 min)
4b Fix               code → sandbox copy → tests, migrate, AI review, risk rules →   people: none
                     PR "Closes TASK-…"; config/data → change set
5 One approval       summary on the ticket + Teams link → Approve / Reject           people: one, ~1 min
6 Deploy             pilot: a person presses Deploy on the card → Press deploy →     people: one click
                     verify → rollback on failure. Later: automatic for low-risk
                     categories in the night window                                   people: none
7 Close              "Resolved" + note to the customer → Confirm or Reopen           people: customer
```

## 3. The parts and where the code goes

| Part | Repo | What it is | Status |
|---|---|---|---|
| **Hub: Copilot module** | `tbocloud/helpdesk` → `helpdesk/copilot/`, `helpdesk/api/copilot*.py` | Runs, root-cause router, approvals, customer messages, change sets, deploy requests, site registry, hub MCP server, worker API, Press adapter | To build (§6.1) |
| **Customer connector** | `tbocloud/helpdesk_client` | Support button, recording/replay, MCP server. Add: `hub_api` write-back, code identity, customizations, deploy status, version history, per-doctype write allow-list, stages/confirm/reopen UI, security fixes | To extend (§6.2) |
| **Worker** | `tbocloud/tbo-copilot` (headless engine app + MCP relay) + new repo `tbocloud/tbo-copilot-worker` (supervisor, sandbox, llm-proxy) | The 24/7 AI agent with tools, sandbox benches, evidence, GitHub pipeline | To build (§6.3) |
| **Deploy** | hub (`helpdesk/copilot/press.py`, `deploy.py`, `verify.py`) | Press API calls, window, lock, verification, rollback | To build (§6.4) |
| **Desktop app** | `tbocloud/tbo-copilot` + `tbocloud/tbo-copilot-plugins` | Optional for developers: connects to the hub MCP server from Settings → MCP (no plugin needed); `tbo.support` plugin stays as a fallback | Done; small follow-ups |
| **Teams bot, Entra sign-in** | hub (`helpdesk/copilot/teams/`) | Buttons in Teams, two-way chat, Microsoft login | Later (§6.6) |

## 4. Root cause decides the path, and what the customer hears

Triage only guesses. The worker investigates first (document Version history: did a person type it or did the system compute it? reproduce in the sandbox; scope: one record or many; error logs; recent commits). It returns `{root_cause_category, confidence, evidence, proposal, questions}`. The hub's router then does exactly this:

| Root cause | What Copilot does | Message to the customer | Approval |
|---|---|---|---|
| `question` | Drafts the answer from the KB and the customer's configuration | AI draft, sent by a support agent | none (the agent's send) |
| `not_allowed_request` (wrong or not allowed method) | Explains why, and the right way or the policy | AI draft, sent by a support agent | none |
| `customer_mistake` (entry mistake, missing data or setting on their side) | Explains kindly, shows the ERP way (cancel and amend for submitted documents), offers prevention as an optional customization | AI draft, sent by a support agent | Data Fix approval only if Copilot prepares the correction |
| `wrong_setting` (on our side) | Changes it on the sandbox, checks, prepares a change set | Templated stages | Config Change (senior if permissions/integrations) |
| `bug` | Reproduces, fixes, regression test, sandbox check, PR | Templated stages: Working on it → Fix scheduled → Resolved | Code Change |
| `data_damaged_by_bug` | Fix the code first, then correct **every** affected record after the deploy verifies | Templated stages | Code+Data, one approval |
| `core_issue` (Frappe/ERPNext) | Workaround in the custom app where possible, else a person decides | "With our team" | none; Task to the developer |
| `unclear` or low confidence | Asks the customer a question, or hands to a person with everything found | "Waiting for you" / "With our team" | none |

Fixed stage messages (no approval): Received, Working on it, Fix scheduled (date), Resolved (+ the approved resolution note), With our team, Waiting for you. Free-text explanations and questions always go through the existing AI suggested-reply card: the agent reads, edits if needed, sends. Tone rules: no blame, show the ERP way, offer prevention as an option, never guess with customer data. Customer actions: Confirm fixed (ticket closes), Still broken / Reopen (always goes to a person), reply (reopens the conversation), accept a quote (customizations, existing estimate flow).

## 5. Design details

### 5.1 Hub: `helpdesk/copilot/` (inside tbocloud/helpdesk)

Follow helpdesk's rules: lifecycle hooks only call methods; typed `@frappe.whitelist` params; test helpers only in `helpdesk/test_utils.py`; tests in `helpdesk/tests/test_*.py` with `hold_commits`; update `docs/` in the same PR; one feature per PR, under ~400 lines, title/body `Closes TASK-YYYY-NNNNN` (auto-merge on CodeRabbit approval + checks).

**Modules**

| Module | Job |
|---|---|
| `settings.py` | Reads HDS Copilot Settings: model map (primary + fallback), templates, sensitive categories, deploy window, approver rota, Press settings |
| `runs.py` | Create a run; `TRANSITIONS` table; `transition()` with a row lock; events; lease claim/heartbeat; realtime `helpdesk:copilot-run` |
| `router.py` | The root-cause router (§4) on `submit_investigation` |
| `approvals.py` | Create (payload hash), assign, decide (first wins), supersede, reminders, reject → follow-up run |
| `customer.py` | Stage messages, explanation drafts via `ai_suggestion.store_suggestion`, confirm/reopen |
| `work_link.py` | One Task per code run (`api/work.create_task_from_ticket`, new `pause_ticket=False`), PR ↔ run, evidence from HD Pull Request |
| `github.py` | `get_pull`, `compare` (changed files), `merge_pull` with the HD GitHub Settings token (later a GitHub App) |
| `risk.py` | Deterministic rules on the real diff → `risk_level`, `sensitive` |
| `registry.py`, `press.py`, `deploy.py`, `verify.py` | Site registry synced from Press; Press client; deploy requests with window and lock; post-deploy checks |
| `mcp/{protocol,auth,registry,tools_read,tools_write,tools_worker}.py` | The hub MCP server; protocol/handler copied from `helpdesk_client/mcp/` |
| `audit.py` | HDS Copilot Call Log + rate limit |
| `helpdesk/api/copilot_mcp.py` | MCP endpoint `handle` (TASK-2026-00013) |
| `helpdesk/api/copilot_worker.py` | `claim_job`, `heartbeat`, `post_events`, `submit_result` (POST, role Copilot Worker) |
| `helpdesk/api/copilot.py` | UI: `get_run_card`, `decide_approval`, `start_run`, `decide_resolution`, `deploy_now` |
| `helpdesk/hd_form_scripts/copilot_actions.js` | Header button + dialog on the ticket page (installed on migrate like `ai_support_actions.js`) |

**Doctypes** (module Helpdesk): HDS Copilot Settings (single; children HDS Copilot Model Map, HDS Copilot Approver, HDS Copilot Message Template), HDS Copilot Run (`CPR-.YYYY.-.#####`: ticket, customer, connection, registry, kind investigate/code/config/data/followup/revert, state, lease fields, task, repository, base_commit, work_branch, pr, head_sha, merge_commit, root_cause_category, confidence, investigation/proposal/evidence JSON, risk_level, sensitive, approval, change_set, action_request, deploy_request, customer_message_draft, handed_over_to, cost, per-state timestamps), HDS Copilot Event (unique run+seq, type, payload ≤16 KB), HDS Copilot Approval (`CPA-…`: type Code Change/Config Change/Data Fix/Code+Data, status Pending/Approved/Rejected/Superseded, payload + payload_hash, sensitive, assigned_to, due/reminded/escalated, decided_by/at/via, note), HDS Copilot Change Set (`CPC-…` + child items with before/after JSON), HDS Deploy Request (`CPD-…`: status Scheduled/Running/Verifying/Succeeded/Failed, scheduled_for, baseline JSON; children Deploy Site, Deploy App), HDS Site Registry (`CPS-…`: customer, environment Production/UAT/Sandbox, connection, press_site, press_release_group, shared_group; child HDS Site App with repo, branch, deployed_commit, drift_status), HDS Copilot Call Log.

Custom fields (via `setup/install.py get_custom_fields()`): HD Ticket `custom_copilot_run`, `custom_copilot_stage`, `custom_root_cause`, `custom_customer_confirmation`, `custom_client_push_hash`; HD Customer `custom_copilot_enabled`, `custom_assigned_developer`, `custom_customer_tier`; HD Agent `custom_copilot_available`, `custom_senior_approver`. HD Pull Request gets `head_sha`, `copilot_run`; HDS AI Usage Log gets `copilot_run`, `job`. New role **Copilot Worker** (API only). Reused as-is: Task, HDS Support Action Request + `approval.py` execution, HDS Support Connection + `MCPClient` + HDS Remote Audit Log, `work_reminders.notify_users`, `chat_notifications`.

**Run states**: Queued → Investigating → (Explaining → Answered) | (Preparing Fix → Awaiting Approval → Approved → Merging → Merged → Deploying → Verifying → Resolved → Closed) ; side states Rejected (→ follow-up run), Escalated, Handed Over, Failed, Cancelled. Each transition: `for_update` lock, validate against `TRANSITIONS[(from, to, actor)]`, write a `state_change` event, update the ticket's stage fields, publish realtime after commit, queue the customer stage message. Leases: heartbeat extends 5 min; a cron (`*/5`) re-queues or fails stale runs. Runs keep the ticket Open so the SLA and reminders keep working (the old "Waiting on Task" pause is not used for Copilot runs).

**The one approval**: payload = canonical JSON `{pr: {repo, number, head_sha}, merge_target, sites[], change_set_hash, action_request_hash, customer_message, risk, evidence}`; `payload_hash` = sha256. Assignment: the customer's `custom_assigned_developer` if available → approver rota (fewest pending, then least recently assigned) → `team_lead`. Sensitive → a `senior` approver. Self-approval blocked for the person who took over. `decide_approval` (POST): lock row; not Pending → "already decided by X at T"; recompute hash from the current PR/change set; mismatch → Superseded + new approval. Approve → Approved → merge queued. Reject needs a note → follow-up run with the note. Notifications: `chat_notifications.send_direct(assignee, text, link)` + channel post when sensitive + HD Notification/email via `notify_users`; reminders every 15 min after `approval_reminder_hours`, reassign to the lead after `approval_escalate_hours`. UI v1: the form script's header button opens a dialog with problem, cause, fix, risk flags, checks table, affected sites, PR link, customer message, Approve / Reject (reason) / Open PR. Later: a `CopilotRunCard.vue` in `TicketDetailsTab.vue`.

**Customer communication**: `customer.send_stage(ticket, stage, context)` renders a template → skip if the hash is unchanged → push the stage to the client via `hub_api.update_ticket` (`support_hub._call_client` moved to `helpdesk/client_api.py`) → insert the message as a Sent Communication via `HDTicket.reply_via_agent` run as the automation user, so email, Chatwoot, the portal and the client comment sync all receive it. Explanations and questions: `store_suggestion` → suggested-reply card → the agent sends; a new `Communication.after_insert` hook moves Explaining → Answered. Confirm/Reopen: `api/copilot.decide_resolution(ticket, confirmed, note)` (same permission pattern as `decide_estimate`) + a banner on the customer portal page; the client site's confirmation also arrives through `sync_conversations`. Reopen → ticket reopened, run Escalated, Task to the customer's developer, stage "With our team".

**Task + PR linkage** (reuse): at the start of a code run, `create_task_from_ticket(ticket, project, task_name="Copilot: …", pause_ticket=False)` as the automation user; the worker's branch is `copilot/TASK-2026-NNNNN-CPR-…` and the PR body says `Closes TASK-2026-NNNNN (CPR-…)`; `github_sync.refresh_row` stores `head_sha` and `copilot_run`; head change → supersede the pending approval; merged → `run.merge_commit`, Merged, create the Deploy Request; `task.notify_ticket_task_completed` says "Fix merged; Copilot will deploy and tell the customer" when a Copilot run is active; `fix_brief._reference` becomes "Closes TASK-…" when the ticket has a task (fixes the current mismatch).

**Hub MCP server** (TASK-2026-00013): endpoint `helpdesk.api.copilot_mcp.handle` (allow_guest GET/POST, own auth; allowed by `helpdesk/auth.py` because the path starts with `helpdesk.`). Auth: `Token key:secret`, `Bearer key:secret`, or a Frappe OAuth bearer token (for the desktop's OAuth 2.1 sign-in) → `frappe.set_user`; Redis session 1 h. Read tools wrap existing permission-checked APIs: `my_work`, `get_ticket`, `search_tickets`, `get_task`, `list_project_tasks`, `search_knowledge_base`, `get_fix_brief`, `get_session_replay`, `get_possible_duplicates`. Write tools (`frappe.has_permission(..., throw=True)`): `add_ticket_comment`, `draft_ticket_reply` (→ `store_suggestion`, never sends), `update_task_status`, `create_kb_article_draft`. Worker tools (role Copilot Worker, lease must be valid): `get_run_context`, `post_event`, `submit_investigation`, `submit_change`, `customer_erp_read` (allow-list of read tools, size caps, `MCPClient(run.connection).call_tool(..., session_id=run)`, `isError` → tool error), `request_input`. Every call → HDS Copilot Call Log in the request transaction; rate limit per user per minute via `frappe.cache`.

**Fixes to existing code this depends on**

| File | Fix |
|---|---|
| `ticket_puller.py:241-250` `_push_back` | raise on `isError` |
| `ticket_puller.py:522-534` | mark a reply synced only on a non-error result |
| `ticket_puller.py:348-401` | push only when status/priority changed (`custom_client_push_hash`); map labels the client cannot accept (Waiting on Task → Paused) |
| `ticket_puller.py:579` | close through the controller, not raw `db.set_value` |
| `approval.py:84-107,134-183` | `for_update` lock; refuse if not Pending; execute once |
| `api/support_hub.py` | a missing permission check on a read endpoint |
| `setup/install.py:470-475` | triage status options add In Progress, Skipped |
| `fix_brief.py:210-212` | task reference instead of "Refs ticket #N" |
| `api/work.py:580` | `pause_ticket` parameter |
| `ai_engine.py` | fallback provider: `get_provider_config` returns primary and fallback; `call_haiku` retries on auth/quota/5xx with the fallback and logs which model answered |

### 5.2 Customer side: `helpdesk_client`

Two doors into the customer site: **`hub_api`** (support-user token, POST only) for the ticket conversation, touching only this app's own doctypes, so it never depends on the global write switch; **MCP** for investigation reads and approved writes. Frappe permissions stay the enforcer, and the hub's own access on the site is limited to what it needs. Old hubs keep working: `register_connection`/`capabilities()` advertise `["hub_api_v1", "mcp_tools_v2"]`; a hub that does not know them keeps using `set_values`/`create_doc`.

**`helpdesk_client/hub_api.py`** (all `@frappe.whitelist(methods=["POST"])`, `_require_support_user()` from `api.py:24-31`, typed params, `ignore_permissions` saves flagged `from_hub`):

| Endpoint | Behaviour |
|---|---|
| `update_ticket(name, values)` | Allow-listed fields: ticket_id, status, status_category, priority, stage, stage_message, handled_by, resolution, deployed_commit, deployed_at. `map_hub_status()` maps hub labels (Waiting on Task/Waiting on Customer/On Hold → Paused; unknown → unchanged, raw label kept in `status_label`). Saves only if something changed. Returns `{ok, applied, ignored}` |
| `add_update(name, hub_ref, stage, message, author_name)` | Appends a `Support Ticket Update` row; idempotent on `(ticket, hub_ref)`; one Notification Log to the raiser |
| `post_reply(name, hub_ref, content, author_name)` | Creates the Comment + an Update row of kind Reply; idempotent on `hub_ref`; the existing `notify_reply` hook notifies |
| `get_ticket_changes(since, limit=200)` | Tickets modified since (status, close/reopen/confirmation fields), customer comments since, `server_time` as the next cursor |
| `capabilities()` | `{client_version, capabilities, site_environment}` |

Customer-side endpoints in `support_ticket.py` (POST, owner or `raised_by` only): `confirm_resolution(ticket, note)` and `reopen(ticket, note)` set `customer_confirmation` Confirmed/Reopened + `confirmed_at`/`reopen_requested`; the hub reads them via `get_ticket_changes` and pushes the real status back. Errors use typed Frappe exceptions (`PermissionError` 403, `DoesNotExistError` 404, `ValidationError` 417) so the hub's `_call_client` keeps working.

**Support Ticket** new fields: `stage` (Received / Working on it / Fix ready / Fix live / Needs you / With a person), `stage_message`, `status_label`, `handled_by`, `resolution`, `deployed_commit`, `deployed_at`, `customer_confirmation`, `confirmation_note`, `confirmed_at`, `reopen_requested`, `reopen_count`, `page_route`, `ref_doctype`, `ref_docname`, `user_roles`, `error_logs`, `code_identity`, `raised_by_email`, `raised_by_name`, child table `updates` (**Support Ticket Update**: hub_ref, kind Stage/Reply/System, stage, message, author_name, posted_at, comment). UI: stage banner (`set_headline`), updates timeline newest-first, resolution box with **Confirm, it's fixed** / **Still broken, reopen** (reopen asks for a note), stage indicator in the list view. Context capture on raise: route, doctype/docname, roles (server adds the user's own Error Logs of the last 24 h, max 10, and `code_identity`, cached 10 min). Microphone optional (`public/js/support_ticket.js:579-600`). Ticket visibility by `owner OR raised_by` (role **All** `if_owner` + `get_permission_query_conditions` + `has_permission` hook) instead of auto-granting Genie User, which would turn Website Users into System Users. `raised_by_email` = User.email → session user if it contains `@` → new setting `fallback_contact_email` (covers Administrator).

**New MCP tools** (`mcp/tools/diagnostic_tools.py`, read-only, support role): `get_code_identity(apps)` (per app: path, version, branch, commit, remote with credentials stripped, dirty flag; reads `.git/HEAD`, refs, `packed-refs`, `config`; `git status --porcelain` with a 5 s timeout; falls back to `sites/apps.json`); `get_customizations(doctypes, since)` (Custom Field, Property Setter, Client/Server Script, Workflow, Print Format, Notification with modified/modified_by); `get_deploy_status(since)` (Patch Log, scheduler state with the inversion at `site_tools.py:32` fixed, workers, error count + top-10 signatures `(app, method, first line)`); `get_error_log` extended with `since, until, reference_doctype, reference_name, method, limit` and derived `app` + top frames; `get_version_history(doctype, name, limit, since)` (Version rows with `actor`: hub / system / import / person). Registry change: `register_tool(..., doctype_args=("doctype",), write=False)`; `execute_tool` requires the support user or the hub role, gates every doctype-bearing argument, routes writes through `check_write_access`; `execute_report` gated by `ref_doctype`; `get_meta` and `get_count` get permission checks.

**Write safety**: settings `site_environment` (Production/UAT/Sandbox), `allowed_write_doctypes` (child HDS Allowed Write DocType: doctype, allow_create/update/delete/submit_cancel), `approval_signing_secret` (set at pairing; existing sites via a hub-initiated `api.set_approval_secret`), `log_reads`, `fallback_contact_email`. `check_write_access(doctype, action, approval)`: enabled → master switch → not blocked / in allowed list → in the write allow-list with the action flag → not in `NEVER_WRITE` (User, Role, Has Role, DocPerm, Custom DocPerm, System Settings, HDS Support Settings, HDS Change Log, Server Script, Scheduled Job Type, Email Account/Domain, OAuth Client, Social Login Key, Bulk Update) → on Production verify the **approval token** (base64url JSON `{change_set, ticket, approved_by, approved_at, exp, scope}` + HMAC-SHA256, `hmac.compare_digest`; scope must contain `(doctype, name)`). New **HDS Change Log** (create-only for the hub role: ticket, change_set, approved_by/at, environment, tool, action, doctype, docname, before/after JSON, status, error, ms) and **HDS Hub Call Log** (writes, failed calls, reads when `log_reads`, one-time logins; 30-day retention).

**Security fixes**: a set of hardening changes to the customer-site app (authentication, request methods, uploads, the lifecycle of the hub's keys, logging); the detailed list stays private until every customer site runs the fixed version.

**Patches**: data backfills and defaults for existing sites. **Rollout note for existing customer sites**: the admin once reviews the allowed, blocked and allowed-write doctypes and sets `site_environment` and `fallback_contact_email`; the hub's `set_approval_secret` call is automatic and visible in the call log.

### 5.3 Worker: engine, supervisor, sandbox, GitHub

**VM**: AWS Graviton `m7g.2xlarge` (8 vCPU, 32 GB, arm64 = Press images), 300 GB gp3 with reflink, Docker + compose, 3 parallel runs. Containers: `supervisor` (Node 22, talks to Docker through a socket proxy limited to containers/exec/networks/volumes/images), `llm-proxy` (LiteLLM: holds the Moonshot and OpenAI keys, mints a per-run virtual key with `max_budget` and 2 h expiry, falls back Kimi → OpenAI), `hub-proxy` (nginx allow-list: only the hub's `copilot_mcp` and `copilot_worker` endpoints), and per run a stack `run-<id>` (`db` MariaDB 10.6 on a reflink copy of the sanitized snapshot, `redis`, `bench` with the app clone at `/workspace/app` and the engine) on an `internal: true` network; `bench` can reach only `llm-proxy` and `hub-proxy`. Inside `bench`, `frappe` (uid 1000) owns the bench and runs tests; the engine runs as `agent` (uid 1001) and owns only `/workspace/app` and tmpfs scratch, so "edits only in the app" is a kernel rule (host-core in `auto` mode allows external paths). Secrets: model keys only in `llm-proxy`; the GitHub token only in supervisor memory; the hub run token in a tmpfs `run.json` (0400) that expires with the lease.

**Headless engine app `apps/tbo-worker-host`** in the fork (listed in `docs/tbo/README.md` as a TBO addition; no Rust change):
- `src/app.ts` copied from `apps/pi-host/src/app.ts`; `src/racp-unix-binding.ts` binds RACP on a Unix socket `/run/tbo/<run>/racp.sock` (pi-host refuses non-loopback binds; the supervisor connects over the shared tmpfs volume).
- `src/mcp-relay.ts`: `@earendil-works/pi-mcp@1.0.1` (already in the lockfile; stdio + Streamable HTTP + headers). At start `mcp.upsert` on host-core `{id: "hub", transport: "http", url, headers: {Authorization: Bearer <run token>}}`, connect, `tools/list` → `PluginToolDef[]` named `mcp_hub_<tool>`.
- `src/launch-with-mcp.ts` wraps `createHeadlessLaunchResolver` (`packages/host-runtime/src/launch-resolver.ts:72`): after `resolve()` sets `pluginTools = relay.toolDefs()` and appends `/context/SYSTEM_APPEND.md` to the system prompt.
- `src/plugins-execute.ts`: `host.onNotification("plugins.execute")` → `relay.callTool()` → `host.call("plugins.resolveExecution", {...})`, mirroring `apps/desktop/electron/main/runtime/host.ts:143-300`, under the 150 s budget.
- `src/local-tools.ts` via `AgentSidecar.setLocalTool` (`packages/host-runtime/src/agent-sidecar.ts:308`): a policy **`Bash`** (allow-list: read-only `git`, `rg`, `grep`, `find`, `ls`, `cat/head/tail/wc`, `python -m py_compile`, `ruff check`, `node --check`; no shell operators except `| head/tail/wc`; runs as `agent` in `/workspace/app`, 120 s, 64 KB), **`run_checks`**, **`run_tests`**, **`bench_migrate`** (fixed commands executed by the supervisor's evidence runner as `frappe` through a Unix socket, so the agent never chooses arguments), `Skill`.
- `src/stage-policy.ts`: the supervisor writes `/run/tbo/<run>/stage`; in `investigate` the app is mounted read-only and Bash is read-only; `implement` remounts rw.
- Session: `permissionMode: "auto"`, `mode: "agent"` (MCP tools are hidden in Plan/Goal). `approval.requested` is answered by the supervisor: allow-once for Read/Glob/Grep/Edit/Write/`mcp_hub_*`, else deny + `permission_denied` event. `input.requested` → hub `request_input`; after 30 min, "take the safest assumption and record it". Limits enforced by the supervisor: tool calls per stage (investigate 60, implement 120, review 30), 90 min wall clock, cost from `usage` events + the virtual key's hard budget, `run_tests` ≤ 6.
- Tests: unit (tool-def mapping, allow-list parser, stage policy, resolveExecution payloads); integration (`vitest` starts a stub Streamable-HTTP MCP server + a real `tbo-worker-host` with a fake provider that returns one `mcp_hub_ping` tool call; asserts the round trip and that `mcp_*` tools are absent in Plan mode).
- Upstream: offer `pi-host --mcp` (headless MCP relay with an injected client seam) to vastsa/PI-Desktop; the TBO app then shrinks to policy + local tools.

**Supervisor `apps/tbo-worker`** (TypeScript, so it reuses `@pi-desktop/racp` `RacpClient` with a Unix-socket transport and `@pi-desktop/shared` event types; TBO-private prompts/policy live in `tbocloud/tbo-copilot-plugins/tbo.worker-policy`, fetched at build by `scripts/tbo/fetch-plugins.mjs`):

| Module | Behaviour |
|---|---|
| `claim-loop.ts` | every 15 s `claim_job(worker_id, free_slots, capabilities)`; lease 5 min; `heartbeat` every 30 s with the lease token + stage (reply may say cancel/takeover); lease lost → stop the engine, never push |
| `outbox.ts` | SQLite WAL: runs, events (run, seq, payload, acked), artifacts; `post_events` batched 1 s / 50, idempotent by `seq` |
| `workspace.ts` | bare mirror per repo fetched with the job's short-lived installation token via `GIT_CONFIG_*` env (never persisted); clone at `deployed_commit`; branch `copilot/TASK-YYYY-NNNNN-r<run>`; `origin` removed; drift → `needs_human`; `gitleaks detect --no-git`; secret files unreadable and reported |
| `context.ts` | `/context` read-only: `ticket.md` (untrusted wrapper, 20k), `triage.json`, `timeline.txt`, `error_logs/*.txt` (top 10 signatures), `code_identity.json`, `customizations.json`, `video/frames/*.jpg` (ffmpeg scene detection, ≤24 + contact sheet), `INDEX.md`, `SYSTEM_APPEND.md` |
| `stages.ts` | one RACP turn per stage: **investigate** (read-only) → the agent must call `mcp_hub_submit_investigation {root_cause_category, confidence, evidence[], proposal, questions}` → **gate** (hub answer via heartbeat: continue / stop with an answer / ask a person) → **implement** (edits + regression test) → **test** (supervisor evidence; failures fed back, ≤3 loops) → **review** (fresh session, strict reviewer prompt on the diff, ≤2 rounds) → `mcp_hub_submit_change {diff_summary, tests, risk, client_summary, functional_checks[], data_change_set?}` |
| `evidence.ts` | produced by the supervisor, never from agent text: static (`py_compile`, `ruff` new findings on changed lines, doctype JSON valid + `modified` bumped, `patches.txt` resolves), `bench migrate` on patched code, module tests base vs fix (`--junit-xml-output`), regression test **fails on base / passes on fix**, `bench build` if `public/` changed, gitleaks on `base..HEAD`; every item `pass / fail / not_run(reason)` |
| `risk.ts` | high if the diff touches `accounts/**`, `stock/**`, `payroll/**`, `hooks.py`, `patches.txt|patches/**`, doctype `*.json`, raw SQL DML, permission code (`ignore_permissions`, `has_permission`, role JSON), dependency files, `.github/**`, or >300 changed lines; medium if no regression test |
| `finish.ts` | push the branch (token in memory), `upload_artifact` (diff, junit, logs, frames, report), `complete {branch, head_sha, evidence, risk}` or `fail {reason}` |

**Sandbox bench**: base image = Press's GHCR arm64 image for the release group if readable (needs `read:packages`, unverified), else `docker/bench/Dockerfile.v15` pinned to the site's Frappe/ERPNext tags, built nightly, keyed by `(frappe, erpnext, apps@commits)`. App-base snapshot: `sandbox.localhost` with apps installed and migrated; MariaDB datadir + `sites/` tarballs under `/var/lib/tbo-worker/snapshots/<key>/`, restored per run by reflink copy. **Customer copy**: the hub requests `press.api.site.backup(name, with_files=False)` and hands the DB-only download to the worker; restored at most once per customer per 7 days into a quarantined stack (no `services` network) and **sanitized before any agent sees it** (`tbo_sandbox/sanitize.py`: strip `__Auth` and reset Administrator, Email Accounts, OAuth Clients, Connected Apps/Token Caches, Social Login Keys, Webhooks disabled, Integration Requests, ZATCA settings/certificates/keys, User api keys, S3/Dropbox/Google/SMS/payment settings, `site_config.json` secrets with a new `encryption_key`; set `host_name` empty, `pause_scheduler 1`, `mute_emails 1`, `developer_mode 1`, `allow_tests 1`; mask User/Contact/Customer/Supplier/Address emails and phones, names optional per `masking.yaml`; drop Error Log, Activity Log, Email Queue, Access Log, `__global_search`; keep Version). Files are never copied (20 GB). **The "UAT check" in the sandbox**: `bench migrate` passes; pages load through `frappe.test_client` (the doctype list, `getdoc` of the reported record, the report's run); the reported case is an agent-written `tbo_checks/repro_<run>.py` that fails on base and passes on fix, also run against the customer copy; no new Error Log signatures (exception type + first `apps/<app>` frame) since the check started, excluding `helpdesk_client.mcp` noise. Cleanup: `compose down -v`, run dir removed after upload, failed runs keep artifacts 24 h.

**GitHub pipeline**: a GitHub App "TBO Copilot" (Contents RW, Pull requests RW, Checks R, Metadata R, Commit statuses R; **no Workflows permission**), installed on `teambackoffice` and `tbocloud`, install requests to the customers' own GitHub organisations (until then those repos are investigate-only → escalate); the hub holds the private key and mints installation tokens scoped to one repo (`contents: write`, 1 h) for the worker. Branch `copilot/TASK-2026-00123-r42`; title `TASK-2026-00123: <fix>`; body sections Summary, Root cause, Change, Evidence table, Risk, Functional checks, Sites that move; trailers `Closes TASK-2026-00123`, `Ticket: HD-…`, `Copilot-Run: CPR-…`; labels `copilot`, `risk:<level>`; commits as a TBO Copilot bot identity. Checks: `ai-review / review` (Kimi, `tbocloud/ai-review`), `task-reference`, `lint` (ruff), `tests` only where the repo has tests; a one-time onboarding PR per customer repo adds the three workflow files. Merge hub-side with the App token, **squash**, only when the approval is bound to the head SHA, all check runs for that SHA succeeded, and the PR is up to date with base (else a `refresh` worker job merges base and re-tests). GitHub Free plan cannot enforce rulesets on private repos, so the hub is the enforcer: the worker token exists only per run, hub code refuses any ref outside `copilot/**`, and direct human pushes remain an accepted, documented risk. Revert: "Rollback" on the card → worker job `revert` (`git revert -m 1 <merge>` on `copilot/TASK-…-revert-r43`) → same checks → one-click approval → merge → deploy.

### 5.4 Deploy through Press

**Pilot mode first.** In the pilot the only trigger is `deploy_now`: the approver or lead presses **Deploy** on the card after reading the sandbox verification; Copilot then runs steps 1–8 below and reports. The scheduler `deploy.run_due_deploys` (cron `*/5`) deploys automatically only for categories listed in the setting `auto_deploy_categories`, which is empty in the pilot and is filled (print formats, reports, non-accounting modules) only after several successful deployments with no rollback.

Hub-side `helpdesk/copilot/press.py` + `deploy.py` + `verify.py`:

| Step | Call / rule |
|---|---|
| Identity | A dedicated Press user in TBO's Press team with an API key/secret (`token key:secret`); Press has no narrower role, so `press.api.*` is restricted to the hub's IP in nginx and every gate stays hub-side. All calls logged (HDS Copilot Call Log, kind Press). Payload shapes are verified against TBO's Press 0.7.0 before build (open item) |
| 1 Register the release | `press.api.bench.fetch_latest_app_update(group, app)` → `deploy_information(group)`; assert the app row's next hash == the merge SHA, else abort and re-approve |
| 2 Select sites | only `deploy_information.sites` rows for the approved sites (never names); ≤6 rows and JSON < 1,000 chars; otherwise sequential batches |
| 3 Window + guard | 21:00–05:59 Asia/Riyadh unless the approver ticked "urgent" (`deploy_now`, lead only); Redis NX lock `copilot:deploy` (TTL 2 h) + per-group lock; before calling, no Deploy Candidate / Build in Pending or Running (retry 2 min, give up after 60 min → reschedule), mirroring `tbo_press_guard` |
| 4 Backup | `press.api.site.backup(name, with_files=False)` per site, wait for Success, store backup names on the HDS Deploy Request; never `skip_backups` |
| 5 Deploy | `deploy_and_update(group, apps=[the changed app row], sites=selected rows, run_will_fail_check=True, trigger_patch_deploy=False)`; store the candidate |
| 6 Poll | Deploy Candidate → Site Update per site (Pending/Running/Success/Failure/Recovered/Fatal) every 60 s, 2 h timeout |
| 7 Verify | via the hub MCP proxy: `get_code_identity` commit == merge SHA; `get_error_log(since=deploy_start)` minus `helpdesk_client.mcp` methods and `ignored_error_titles` → no new signatures; `/api/method/ping`; scheduler enabled; smoke = the read-only functional checks from the approved card (report runs, document loads). Success → run Resolved, customer told |
| 8 Rollback | a failed Site Update is recovered by Press itself → request Failed, run Escalated, channel post with Press links; a verification failure → the revert flow (§5.3) with priority; database restores stay manual and the escalation lists the backup names from step 4 |
| Shared groups | the card lists every site in the group ("moves now" vs "Press auto-update moves it tonight"); more than one customer in the group → senior approver |

`registry.sync_from_press` (hourly and after each deploy) fills HDS Site Registry from `deploy_information` (apps, branches, commits) and cross-checks the client's `get_code_identity` → `drift_status`. **Data/config change sets** (`HDS Copilot Change Set`, ordered ops `{tool, doctype, name, before, after}`) are dry-run on the sandbox customer copy first; after the one approval the hub applies them through `MCPClient` write tools with the approval token, each audited and visible in the site's Version history, batches ≤200 tagged `tbo_fix_batch`; submitted accounting/stock documents are never edited (cancel → amended copy → submit); previous values are exported as a rollback artifact. For "a bug caused the data": the PR is merged and verified first, then the change set runs, both on one approval card.

### 5.5 AI models: Kimi first, OpenAI fallback

- One **model map** in HDS Copilot Settings: per job (triage, answer, investigate, fix, review, summary) a primary and a fallback `{provider, model}`. Mirrored to the worker through `get_run_context`.
- **Hub-side jobs** (triage, suggested replies, KB drafts) use `ai_engine.call_haiku`; the hub's provider is set to OpenAI-compatible Kimi (Moonshot International, `https://api.moonshot.ai/v1`, `kimi-k2.6`), fallback OpenAI (`gpt-5.x`); the fallback kicks in on 401/402/429/5xx or a timeout, and the usage log records the model that answered.
- **Worker jobs** go through the worker's `llm-proxy`, which holds both keys, tries Kimi, falls back to OpenAI, enforces the per-run budget, and logs tokens/cost per run and job to the hub (`HDS AI Usage Log` with `copilot_run`, `job`). The pi engine itself sees one OpenAI-compatible endpoint (the proxy), so switching models is a proxy setting.
- Customer data in prompts: the ticket, relevant code, small masked samples; never bulk records. Provider data terms are recorded before real customer tickets are used (Moonshot now, OpenAI next).
- A fixed evaluation set (seeded-bug fixture app + real closed tickets) is re-run on every model/prompt change; results in `docs/tbo-copilot-models.md`.

### 5.6 Later development (designed now, built after the pilot)

- **Teams bot with buttons**: single-tenant Azure Bot; endpoint `helpdesk.api.copilot_teams.messages`; Bot Framework JWT validation; Adaptive Card `Action.Execute` verbs approve/reject/takeover/refresh that call the same `approvals.decide()` with `decided_via=Teams`; thread replies become guidance for the run (`HDS Copilot Inbox`); users mapped to Frappe agents by email (`HDS Teams User`); the webhook stays as fallback. Needs: Azure Bot registration by the Microsoft 365 admin.
- **Microsoft Entra sign-in** for TBO Support and the desktop app; roles from Entra groups; API keys replaced by OAuth sign-in (the hub's OAuth Client record; the desktop already supports OAuth 2.1 for MCP servers).
- **Press UAT** for customer acceptance of customizations (existing estimate flow + a UAT site); Copilot change sets applied to UAT first when a customer wants to see them.
- **Vue card** on the ticket page; a `/copilot` board (runs by stage, approvals inbox, registry drift).
- **Proactive error watch** (new Error Log patterns on customer sites open tickets before the customer notices) and **known-issue memory** (error → root cause → fix PR → KB draft).
- **Deploy train** (approved fixes for the same bench go out together) and per-category auto-deploy for proven low-risk changes (print formats, reports) once measured.

## 6. What TBO must provide (and when)

| Needed | For | By when |
|---|---|---|
| The helpdesk maintainer's agreement on the `helpdesk/copilot/` PR series and the `helpdesk_client` security PRs (they own both apps) | everything | Phase 0 |
| Moonshot (Kimi) key + OpenAI key; accept both providers' data terms before real customer tickets | hub AI + worker `llm-proxy` | Phase 0 |
| Outgoing email on the hub (`enable_reply_email_via_agent`) | customer emails | Phase 1 |
| Approver rota, senior approvers, the sensitive-category list, a default project for Copilot tasks | approvals | Phase 1 |
| A dedicated Press user + API key, nginx IP rule, a backup download path; confirmation of the Press 0.7.0 API shapes | sandbox copies, deploys | Phase 3 / 5 |
| AWS Graviton VM `m7g.2xlarge` + 300 GB (about $300/month) | worker | Phase 3 |
| GitHub App "TBO Copilot" created by an org owner, installed on `teambackoffice` + `tbocloud`; install requests to the customers' own GitHub organisations; GHCR `read:packages` (or accept the pinned Dockerfile) | PRs, images | Phase 3 |
| A pilot customer (one whose apps and local test site we already have) and `copilot_enabled` on that customer | pilot | Phase 6 |
| Later: an Azure Bot registration (Teams bot), an Entra sign-in app | §5.6 | Phase 7 |

