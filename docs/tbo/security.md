# TBO Copilot security review

**Reviewed:** 13 Nov 2026, for the pilot (TBO Copilot Phase 21, TASK-2026-00024).

**Against:** the plugin specification in [`docs/spec/07-plugins/`](../spec/07-plugins/13-plugin-permissions-matrix.md) and the five rules of the brief:
- minimal permissions;
- `net.domains` locked down;
- secrets only where the platform allows;
- every write approved and logged;
- no customer data in logs.

**What was reviewed:**
- the three plugins the installers ship:
  - `tbo.theme`;
  - `tbo.support`, including the AWS tool (PR #24) and the task actions (TASK-2026-00021);
  - `tbo.frappe-dev` (PR #25);
- the TBO Support (hub) endpoints they call;
- the hub's MCP server;
- the Teams bot.

## 1. The result

| Rule | Result |
|---|---|
| Minimal permissions | Each plugin asks only for what its features use (§2). `provider.register` is now rated high in the install dialog and the devkit (F6) |
| `net.domains` locked down | `tbo.support` reaches only TBO Support, the demo hub and the TBO AI gateway. The copy that ships no longer lists this computer (F4). The other two plugins have no network permission |
| Secrets | No secret is kept in plugin settings. The TBO Support sign-in is in the operating system's credential store and the TBO AI key in the app's own secret store: both exceptions the platform allows (F9) |
| Writes approved and logged | A change to a system (Press, AWS, a deploy, a fix) waits for another person's approval in TBO Support, as before. A write on a person's own work needs that person's yes: fixed on the hub (F2), and in the desktop app with PR #24 (F3). Every write is logged |
| No customer data in logs | The hub's logs keep identifiers, sizes and fingerprints, never text or results (F1). With PR #24, searches leave the app by POST, so its network log holds no search words (F5) |

## 2. The bundled plugins

| Plugin | Permissions | `net.domains` (shipped) | Tools and risk | Runs outside the permission model |
|---|---|---|---|---|
| `tbo.theme` 1.0.0 | `ui.theme` | none | none | nothing |
| `tbo.support` (0.4.0 with PR #24 and TASK-2026-00021) | `agent.prompt.inject` (its skills), `agent.tool.register`, `net.fetch`, `provider.register` (the TBO AI row), `shell.openExternal` (the sign-in page), `ui.panel` | `teams.teambackoffice.com`, `demo-tbo.tbocloud.in`, `copilot-gateway.tbocloud.in` | `tbo_support` reads (low); its writes in `tbo_support_change` (high, F3); `tbo_aws` (medium) | `security` (macOS) or `powershell` (Windows) for the saved sign-in; for `tbo_aws`, `uv` runs the pinned AWS API MCP server with the person's own `~/.aws` profile |
| `tbo.frappe-dev` 0.1.0 (PR #25) | `agent.prompt.inject` (its skills), `agent.tool.register` | none | `tbo_dev` (medium); `tbo_dev_pr` (high) | `git`, `gh`, `uv` (pre-commit, Semgrep, flake8, ruff at pinned versions) and `bench`, as the person, in the repository open in the workspace and their bench |

**What the risk means in the app:**
- **low:** runs without asking.
- **medium and high:** the app asks when the permission mode is *Ask every time*. The person may answer **Allow for this chat**.
- **Auto:** the app asks for nothing. The pilot uses *Ask every time* ([getting-started.md](getting-started.md)).
- **Plan and Goal modes:** a plugin tool may run only the actions it lists as plan-safe (reads).

**Programs the plugins start:**
- Always with a fixed program and an argument list, never through a shell.
- With a time limit, and the whole process tree is stopped at the limit.
- A secret travels only on standard input.
- Tests: `tbo/plugins/tests/`.

## 3. Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | The hub's logs held customer text: Call Log arguments and the start of each result, Remote Audit Log arguments, results and errors, the Error Log's message of a failed MCP tool, and a Teams message in its background job's arguments | High | **Fixed** (helpdesk `tbo-copilot`, Phase 21): identifiers kept, text as length and keyed fingerprint, results as size, errors as first line with addresses and long numbers masked; the patch `trim_copilot_logs` rewrote existing rows; the Teams job carries a cache key |
| F2 | The hub's MCP write tools trusted the client to have asked the person; the snooze, `decide_action` and `mark_action_executed` were not logged | High | **Fixed** (hub): every write tool requires `confirmed: true` and writes nothing without it; the three are logged |
| F3 | `tbo_support` is declared low risk, so the app runs it without asking, yet it holds `press_backup` (runs at once), `press_action` (asks an approver) and `start_task` (moves the person's task) | High | **Fixing in PR #24** (and the TASK-2026-00021 commit on it): the three move to a new tool `tbo_support_change`, risk high; `tbo_support` keeps only reads |
| F4 | The shipped `tbo.support` listed `localhost`, `*.localhost` and `127.0.0.1` in `net.domains`, so an installed app could reach services on the person's computer | Medium | **Fixed** (this repository): `scripts/tbo/fetch-plugins.mjs` removes local hosts from the copy that ships; developers load `tbo/plugins/tbo.support` as a development plugin to test against a local bench |
| F5 | Searches (tickets, knowledge base, Press sites) and ticket list filters were sent by GET, so the words were in the app's network log and the hub's access log | Medium | **Fixing in PR #24**: free-text reads go by POST |
| F6 | `provider.register` was not in the install dialog's risk table (it showed high only as an unknown permission) nor in the devkit's high-risk list | Low | **Fixed** (this repository): listed as high in both; `apps/desktop/test/tbo-permission-risk.test.mjs` checks the dialog never rates a permission below the matrix |
| F7 | The devkit's high-risk list lacks ten permissions the matrix rates high (for example `agent.extension`, `mcp.server.local`, `desktop.control`, `session.read`). Only its warning to plugin authors is missing; the install dialog rates them high | Low | **Open:** upstream's code, and no TBO plugin uses them; to be logged as a task |
| F8 | `tbo.support` and `tbo.frappe-dev` start programs (§2), which the permission model does not cover | Accepted | Kept small and fixed (§2), and written down here. `tbo_dev_pr` never pushes to a default or protected branch and never force-pushes |
| F9 | The TBO Support sign-in is kept in the macOS Keychain or Windows DPAPI files, not in plugin private settings | Accepted | The platform forbids secret plugin settings (D018) and opens its secret store to a plugin only for its own provider row's key (ADR 0319), which holds the TBO AI key. See [tbo-support-plugin.md §7](tbo-support-plugin.md#7-sign-in-and-secrets) |
| F10 | Microsoft: the meetings app's Graph permission `Calendars.ReadWrite` reaches every mailbox; offboarding's `User.Read.All` reads the whole directory | Medium | **Admin step:** an Exchange ApplicationAccessPolicy limits meetings to staff mailboxes ([teams.md §4](teams.md#4-meetings-limit-the-calendar-permission)). `User.Read.All` is read-only and no policy narrows it; accepted |
| F11 | The Teams bot accepts Bot Framework calls from TBO's tenant only, and has no Graph permission | None | As built. Its outgoing token falls back to Bot Framework's own tenant only when the bot is registered multi-tenant (the demo hub's bot) |

## 4. What is logged where

| Where | What it keeps | How long |
|---|---|---|
| HDS Copilot Call Log (hub) | Every Copilot action from Teams, the panel, the desktop app and MCP clients: who, channel, tool, status, time taken, ticket, task or run, arguments (identifiers as they are, text as length and fingerprint), the result's size | 90 days |
| HDS Remote Audit Log (hub) | Every call to a customer's ERP site through the hub: tool, arguments as above, the result's size, an error's first line (masked) | 365 days |
| Error Log (hub) | A failed MCP tool: its type and traceback, without the error's own words | Frappe's Error Log settings |
| Background jobs (hub) | A Teams message's job: a cache key; the message itself waits in the cache for 15 minutes | The job registry's own time |
| The app's log (desktop) | Each tool call: the action, and for `tbo_support` the ticket number; never content | On the computer |
| The app's network log (desktop) | Addresses and method names; with PR #24, search words and filters travel in POST bodies | On the computer |

**Not logs:** tickets, chats, Copilot runs and approvals are the team's work records. They keep their content under TBO Support's permissions. An approval holds the exact command the approver sees.

## 5. Checking it again

- **Permissions and domains:** `node --test apps/desktop/test/tbo-fetch-plugins.test.mjs apps/desktop/test/tbo-permission-risk.test.mjs`, and the plugins' own tests in `tbo/plugins/tests/`.
- **The hub:** `helpdesk/tests/test_copilot_pilot_ready.py` (logs without customer text, confirmed writes, feedback, the Teams package, the pilot's numbers).
- **Before each release:** read the shipped manifests in `apps/desktop/resources/plugins/` after `node scripts/tbo/fetch-plugins.mjs`.
