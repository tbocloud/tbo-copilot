# Phase 1b: Hub MCP server (TASK-2026-00013)

**Status:** approved 9 Oct 2026; built and checked on the pair on 9 Oct 2026; **pushed to `tbo-copilot`** in both repos (helpdesk f648e2f, which joins the first push's history without a force push; helpdesk_client 88f97f0); the desktop app check is yours. See "As built" at the end. **Estimate:** about 8.5 developer-days, three pieces (H4, H5 in helpdesk; C6 in helpdesk_client). **Design reference:** `../system-design.md` §5.1 (Hub MCP server), §5.2 (new MCP tools), §5.3 (the worker's hub token); `../build-plan.md` Phase 1b; the TASK-2026-00013 brief. **Built on:** the `tbo-copilot` branch of each repo, first brought up to date with `main`.

## Goal

1. **People.** TBO staff use tickets, tasks and the knowledge base from the TBO Copilot desktop app, or from any MCP client such as the MCP Inspector, **as themselves, with their own permissions**: read, plus four write tools that never send anything to a customer. This is TASK-2026-00013.
2. **The worker.** The Copilot worker (built in Phase 1c) gets its tools from the same server. It can read the run's context, report events and its investigation, and read the customer's ERP through the hub (allow-listed and logged). It never holds customer credentials.
3. **The customer side.** helpdesk_client gets the diagnostic tools Copilot needs to find a root cause: code identity, customizations, deploy status, a richer error log, and version history (who changed a record: a person, the system, an import or the hub).

## What you will see at the end (the demo on the local pair)

1. **MCP Inspector** (`npx @modelcontextprotocol/inspector`), Streamable HTTP, URL `http://tbo.localhost:8002/api/method/helpdesk.api.copilot_mcp.handle`, header `Authorization: token <key>:<secret>` of a test agent:
   - it lists 17 tools;
   - `my_work`, `get_ticket 0236`, `search_tickets "invoice"` and `search_knowledge_base` answer;
   - a ticket outside the agent's team, or an Administrator key, is refused.
2. **TBO Copilot desktop app:** add the server in Settings → MCP (HTTP endpoint + the same header), then use it in Agent mode:
   - "What's on my plate today?"
   - "Summarise ticket 0236 with its triage."
   - "Add an internal note to 0236": an approval card first, then the note appears under the agent's name.
   - "Draft a reply to 0236": the suggested-reply card is filled and nothing is sent.
3. **The worker's run token:**
   - the fake worker claims a run and calls `get_run_context` with its run token;
   - it reads customer.localhost through the hub with `customer_erp_read`: `get_code_identity`, `get_error_log`, and `get_version_history` of a Sales Invoice;
   - it reports with `submit_investigation`, and the run is routed as in Phase 1a;
   - after the lease ends the token is refused;
   - a person's key cannot call worker tools, and a run token cannot call people's tools.
4. **Call log:** every call is in **HDS Copilot Call Log** (who, tool, ticket or task or run, time, result). A burst over the per-minute limit is refused with "rate limited".

## Decisions in this plan that differ from the design or the brief (please confirm)

| # | The design or brief said | This plan | Why |
|---|---|---|---|
| 1 | Brief: a PR into `main`, CI green, the helpdesk maintainer reviews | Commits go to `tbo-copilot` and reference TASK-2026-00013; the module tests are run locally | Your rule of 9 Oct (never `main`, no PRs into `main`). CI does not run on pushes to `tbo-copilot`, and Actions are blocked on the private repos anyway |
| 2 | Auth: API key, or a Frappe OAuth token for the desktop's OAuth 2.1 sign-in | API keys now (`Authorization: token key:secret`, checked by Frappe itself before our code runs). Frappe OAuth tokens pass the same check, but the desktop's OAuth sign-in is not built now; it moves to the later Entra work (§5.6) | The desktop's OAuth flow needs discovery metadata, PKCE and client registration on the hub; Frappe 15's discovery URL is a redirect, which the desktop treats as missing |
| 3 | Redis MCP sessions, 1 hour | No sessions: every request is authenticated from its header, and no session id is needed | The desktop sends the header on every request but never reconnects when a session expires, so after an hour every call would fail |
| 4 | Any user with a key | Agents only, never Administrator; customers later | The brief says "never use Administrator"; all v1 tools are agent tools |
| 5 | The worker's token as `Authorization: Bearer <run token>` | Its own header, `X-Copilot-Run-Token: <run>:<lease token>` | Frappe rejects an unknown Bearer token before the endpoint runs. The own header works only on this endpoint, only for that run's worker tools, and only while the lease lives |
| 6 | Brief's tool list | The brief's 10 tools + 7 companions that wrap existing APIs. Left out: meetings (`start_meeting_now`, `schedule_meeting`), which send invitations to customers. `submit_change` and `request_input` move to Phase 1c | Companions save the model round trips; meetings act outside TBO; the worker that needs the two worker tools comes in 1c |
| 7 | "See how HDS MCP Call Log is used" | A new **HDS Copilot Call Log** | HDS MCP Call Log is a child table of an AI investigation session, so it cannot hold calls that belong to no session |
| 8 | (not in the design) | Also fix three permission gaps found while planning (H5) | Details stay private until the fix is deployed |

## What changes, PR by PR

Order: H4 → H5 on helpdesk, C6 on helpdesk_client (in parallel). Step 0: rebase `tbo-copilot` onto the latest `main` in both repos and re-run the Phase 0/1a module tests.

### H4 (helpdesk): the MCP endpoint, auth, call log, rate limit, read tools (≈ 3.5 days)

| Item | Detail |
|---|---|
| `helpdesk/api/copilot_mcp.py` `handle()` | `@frappe.whitelist(allow_guest=True, methods=["POST", "GET", "DELETE"])`, returns a raw JSON-RPC `Response` (not Frappe's `{"message"}` wrapper). Handles `initialize` (answers the client's `protocolVersion` when supported: 2025-11-25, 2025-06-18, 2025-03-26; else the newest), `ping` → `{}`, `notifications/*` → 202, `tools/list`, `tools/call`, batches, numeric and string ids. GET and DELETE → 405 (no event stream, no sessions). Unknown methods → -32601 |
| `helpdesk/copilot/mcp/protocol.py` | JSON-RPC helpers copied from `helpdesk_client/mcp/protocol.py`; server name `tbo-support-hub` |
| `helpdesk/copilot/mcp/auth.py` | `identify() -> Caller(user, run)` for every request. **A person:** Frappe has already checked `token key:secret` (or a Frappe OAuth token). The user must be enabled, not Administrator or Guest, and an agent (`is_agent`). **The worker:** see H5. Anything else → HTTP 401 with a JSON-RPC error |
| `helpdesk/copilot/mcp/registry.py` | `register_tool(name, *, kind, description, input_schema, handler, annotations)` with `kind` read / write / worker. `tools_for(caller)`: people get read + write; a run token gets worker tools only. `call(caller, name, arguments)`: checks the schema's required keys and types, runs the handler, and returns a text block of compact JSON. Refusals the caller caused (permission, validation, not found, rate limit) → `isError` with the reason in the first 500 characters and no Error Log entry; anything else → Error Log + `isError` |
| `helpdesk/copilot/audit.py` | `log_call(...)` writes HDS Copilot Call Log inside the request. `check_rate_limit(user)`: a per-user, per-minute counter in Redis (the pattern of `task_descriptions.throttle_drafts`); over the limit → refused and logged as Limited |
| `HDS Copilot Call Log` (`hash`, `in_create`) | `user`, `kind` (MCP person / MCP worker), `tool`, `status` (OK / Refused / Error / Limited), `ms`, `ticket`, `task`, `run`, `arguments` (≤ 2000 chars), `result` (≤ 500 chars). Read: System Manager, Agent Manager. Kept 90 days (`default_log_clearing_doctypes`) |
| HDS Copilot Settings | `mcp_enabled` (Check, default on), `mcp_calls_per_minute` (Int, default 120) |
| `helpdesk/copilot/mcp/tools_read.py` | The 13 read tools below. Each calls the existing permission-checked API as the caller. Results are trimmed for the model (the plugin's limits: last 15 messages at 2,500 chars, notes at 1,500, description at 6,000, at most about 60,000 chars). HTML is turned into text, and customer-written text is wrapped in `<untrusted_ticket_content>` |
| Tool descriptions | Key words first, because the desktop shows only 120 characters per tool in its catalog; short names (`mcp_tbo_support_get_ticket`) |
| `docs/tbo-copilot.md` | The MCP section: URL, auth, the tool list, the desktop setup, limits |
| Tests | `tests/test_copilot_mcp_protocol.py` (initialize version answer, ping, notifications 202, GET 405, batch, unknown method, raw JSON-RPC body), `tests/test_copilot_mcp_auth.py` (agent key passes; Administrator, a non-agent and Guest refused), `tests/test_copilot_mcp_read_tools.py` (each tool through the endpoint; a ticket the agent cannot read is refused; trimming; untrusted wrapper), `tests/test_copilot_call_log.py` (every call logged; rate limit) |

### H5 (helpdesk): write tools, the worker's run token and tools, three permission fixes (≈ 2.5 days)

| Item | Detail |
|---|---|
| `helpdesk/copilot/mcp/tools_write.py` | The 4 write tools below. Each repeats the guard of the UI path it stands for, and none sends anything to a customer |
| Run token | `claim_job` already returns a lease token. HDS Copilot Run gets `worker_user`, set at claim. A request with `X-Copilot-Run-Token: <run>:<token>` and no Authorization header is checked with `runs.check_lease`; the request then runs as the run's `worker_user`, scoped to that run. The token dies with the lease |
| `helpdesk/copilot/mcp/tools_worker.py` | The 4 worker tools below |
| `customer_erp_read` | Calls the run's customer connection through `MCPClient(run.connection).call_tool(tool, args, session_id=run)`. Allow-listed tools only: `get_doc`, `get_list`, `get_count`, `get_meta`, `get_error_log`, `execute_report`, `get_installed_apps`, `get_site_info`, plus C6's `get_code_identity`, `get_customizations`, `get_deploy_status`, `get_version_history`. Never a write tool. The existing limit clamps apply; the result is capped at 64 KB; logged in both HDS Remote Audit Log and HDS Copilot Call Log |
| Permission fixes (`api/support_hub.py`) | Three endpoints keep to what the agent may see; details stay private until deployed |
| Tests | `tests/test_copilot_mcp_write_tools.py` (each write tool as the agent; refused without permission; nothing sent: no Communication created), `tests/test_copilot_mcp_worker.py` (token valid only with a live lease; another run's token refused; worker vs people tools kept apart; the allow-list refuses `set_value` and unknown tools; result cap; an `isError` from the site becomes a tool error), `tests/test_support_hub_permissions.py` (the three fixes) |

### C6 (helpdesk_client): diagnostic tools, gating, two MCP fixes (≈ 2.5 days)

| Item | Detail |
|---|---|
| `mcp/tools/diagnostic_tools.py` | `get_code_identity(apps)`: per app, the version, branch, commit, remote (credentials stripped) and a dirty flag, read from `.git` files with `git status --porcelain` under a 5-second timeout; falls back to `sites/apps.json`. `get_customizations(doctypes, since)`: Custom Field, Property Setter, Client and Server Script, Workflow, Print Format, Notification, with modified and modified_by. `get_deploy_status(since)`: Patch Log, scheduler state, workers, error count and the top 10 error signatures (app, method, first line). `get_version_history(doctype, name, since, limit)`: Version rows with `actor` = hub, system, import or person |
| `get_error_log` | New filters: `since`, `until`, `reference_doctype`, `reference_name`, `method`; adds the derived `app` and the top frames |
| Registry | `register_tool(..., doctype_args=("doctype",), write=False)`: every argument that names a doctype is gated, including lists (`get_customizations(doctypes=[...])`), not only `doctype` |
| MCP fixes | `ping` → `{}`; authentication tightened (details stay private until deployed) |
| Tests | `tests/test_diagnostic_tools.py` (each tool; blocked doctypes refused; the git timeout; credentials stripped from the remote), `tests/test_mcp_security.py` extended (ping; authentication) |

## The tools

| Tool | Kind | Wraps (existing API) | Permission it keeps |
|---|---|---|---|
| `my_work` | read | `helpdesk.api.work.get_my_work` | agent; own work |
| `get_ticket` | read | `hd_ticket.api.get_one` + `support_hub.get_triage` + `api.ai_suggestion.get_suggestion` | ticket read |
| `search_tickets` | read | `api.search.search` for words; `frappe.get_list("HD Ticket")` for status, priority, customer, assigned to me (fixed fields, at most 50) | ticket list rules |
| `get_task` | read | `tasky.api.get_task_detail` | task read |
| `list_projects` | read | `tasky.api.get_projects` | project read |
| `list_project_tasks` | read | `tasky.api.get_kanban_tasks` | project read; members see their own tasks |
| `search_knowledge_base` | read | `api.article.search` | published articles |
| `get_kb_article` | read | `api.knowledge_base.get_article` | drafts for agents only |
| `get_fix_brief` | read | `api.fix_brief.get_fix_brief` | agent + ticket read |
| `get_possible_duplicates` | read | `api.duplicates.get_possible_duplicates` | agent + ticket read |
| `get_session_replay` | read | `api.session_replay.get_session_replay` (summary and timeline only) | agent + ticket read |
| `get_calendar` | read | `api.calendar.get_calendar` | agent; the team view only for leads |
| `get_copilot_run` | read | `api.copilot.get_run` | agent + ticket read |
| `add_ticket_comment` | write | `HDTicket.new_comment`, as the UI does | agent + ticket read; an internal note, never shown to the customer |
| `draft_ticket_reply` | write | `ai_suggestion.store_suggestion`, guarded like `regenerate_suggestion` | agent + ticket write + open ticket; fills the suggested-reply card, sends nothing |
| `update_task_status` | write | `tasky.api.update_task_status`; On Hold → `hold_task` (reason), Completed → `complete_task` (hours) | task write |
| `create_kb_article_draft` | write | insert HD Article as the user (no `ignore_permissions`), status Draft, category General | HD Article create; never published |
| `get_run_context` | worker | `copilot.runs.run_context` | the run's live lease |
| `post_event` | worker | `copilot.runs.add_event` (idempotent by `seq`) | the run's live lease |
| `submit_investigation` | worker | `copilot.router.route` | the run's live lease |
| `customer_erp_read` | worker | `MCPClient(run.connection)`, allow-listed reads | the run's live lease; the run's own customer site only |

## How the desktop app connects

- **Settings → MCP → Add → HTTP endpoint.** URL: the hub's `.../api/method/helpdesk.api.copilot_mcp.handle`. Header: `Authorization: token <key>:<secret>`, the person's own key. Then Test connection.
- **The same config as a file:** `~/.agents/servers/tbo-support.json` with `transport: "http"`, `url`, `headers`.
- **What the app does with the tools:**
  - The tools appear as `mcp_tbo_support_<tool>`.
  - They are on demand: the model finds them with ToolSearch.
  - In Ask mode every call shows an approval card. The app treats every MCP tool as medium risk, reads included; "Allow for session" works per tool.
  - MCP tools are hidden in Plan and Goal mode. The read-only `tbo.support` plugin stays for those modes.

## Out of scope

The desktop's OAuth sign-in (later, with Entra), customers as MCP users, meetings tools, `submit_change` and `request_input` (Phase 1c), the worker itself and its relay (Phase 1c), approvals (1d).

## How it is built and tested

- **Branches:** `tbo-copilot` in both repos, after step 0 (rebase onto `main` and re-run the module tests). One commit per piece, each referencing TASK-2026-00013.
- **Migrate:** after each schema change, `bench --site tbo.localhost migrate` or `bench --site customer.localhost migrate`.
- **Tests:** module tests only on the local sites, never the full suite.
- **Demo agent:** a test agent user with API keys on tbo.localhost (never Administrator).
- **Inspector:** `npx @modelcontextprotocol/inspector`, with the Authorization header set as a custom header.
- **Push:** only when you say push, and only to `tbo-copilot`.

## Checkpoint (demo on the local pair)

Steps 1–4 of "What you will see", plus:
- the module tests green on both sites;
- `GET` on the endpoint returns 405;
- a request with neither a key nor a run token returns 401;
- opening Settings → MCP in the desktop keeps the server green, because `ping` answers.

## Risks

- **The key on the laptop.** The desktop keeps the Authorization header in plain text in `~/.agents/servers/<id>.json`. Use the person's own key, never an admin key, and regenerate it if a laptop is shared or lost. OAuth sign-in removes this later.
- **Approval cards.** Every MCP call shows one in Ask mode; Auto mode allows the calls. This is the desktop's rule, not the server's.
- **Customer data to the AI provider.** `customer_erp_read` sends customer data to the model provider. It is for the worker only, allow-listed and capped; record the provider's data terms before real customer tickets (as in §5.5).
- **Shared files.** `hooks.py` and `install.py` are the helpdesk maintainer's daily files: minimal lines.
- **Commits mid-request.** `MCPClient` commits after each audited call, so the call log row is committed early in `customer_erp_read`. This is acceptable.
- **Changes on `main`.** `main` keeps moving: rebase `tbo-copilot` before each push.

## What TBO must provide for this phase

Nothing new. For the desktop demo, your agent account on tbo.localhost with API keys (I can create a test agent instead).

## As built (9 Oct 2026)

| Piece | Repo, branch `tbo-copilot` | Commit | Tests |
|---|---|---|---|
| Step 0 | helpdesk rebased onto main a0b08bb (15 newer commits); helpdesk_client was current | Phase 0/1a now f987b46 … 82b4bb8 | Phase 0/1a modules re-run: green |
| H4 | helpdesk | ddd67fc | `test_copilot_mcp_protocol` 12, `test_copilot_mcp_auth` 5, `test_copilot_mcp_read_tools` 10, `test_copilot_call_log` 4 |
| H5 | helpdesk | 7d389a8 | `test_copilot_mcp_write_tools` 8, `test_copilot_mcp_worker` 9, `test_support_hub_permissions` 5 |
| C6 | helpdesk_client | 76f9281 | `test_diagnostic_tools` 10, `test_mcp_security` 13 (+2) |
| Test fixes | helpdesk 4776b25; helpdesk_client d030291, adbaf8c, 88f97f0 | | see below |

**Step 0 conflicts:** `test_utils.py` (both sides added helpers at the end: kept both); `tasky/api.py` `_assign_user` (main now passes `assigned_by` and a note; kept that with our fallback for Frappe 15, which has `assign_to.add` but not `_add`).

**Found while building:**
- A new Check field's default does not reach a Single saved before it existed: patch `v16_0_2.copilot_mcp_defaults` switches the MCP server on.
- A task's hold reason is a fixed list; the tool offers exactly that list, and a test checks it still matches the field.
- `customer_erp_read` refuses write tools at the schema level (enum), before the hub calls the site.

**Checks on the pair:**
- **MCP Inspector:** `npx @modelcontextprotocol/inspector --cli … --transport http --header "Authorization: token …"` listed 17 tools and called `get_ticket 0236`, `search_tickets`, `my_work` and `get_copilot_run`.
- **curl:**
  - `initialize` answered 2025-06-18;
  - `notifications/initialized` got 202;
  - GET got 405, and a request without a key got 401;
  - `add_ticket_comment` and `draft_ticket_reply` on 0236 were written as the test agent, with nothing sent to the customer;
  - every call was in HDS Copilot Call Log.
- **Worker:**
  - `claim_job` over REST, then the run token: the 4 worker tools only;
  - `customer_erp_read` read customer.localhost through the hub with `get_site_info`, `get_code_identity` (helpdesk_client `tbo-copilot` 76f9281, clean), `get_version_history` (the hub's own edits marked "hub"), `get_deploy_status` and `get_customizations`; `set_value` was refused;
  - `submit_investigation` routed the run, after which the token got 401.
- **Test agent:** `mcp.agent@example.com` (Agent role, API keys) on tbo.localhost; worker user `copilot.worker@example.com` (Copilot Worker).

**Cleaned up on 9 Oct:** test runs had left data on the local sites, because some code commits by design and those tests only rolled back:
- 8 fake connections, 2 customers, tickets 0242, 0243, 0244 and 0247, and about 680 pull errors on tbo.localhost;
- customer ticket SUP-2026-00021 and 15 test Error Logs on customer.localhost.

All were removed, and the tests now use `hold_commits`. The Error Log cleanup rolls back before it commits.

**Still to do:** connect the TBO Copilot desktop app (Settings → MCP), and check that the server stays green when Settings → MCP is opened (ping).
