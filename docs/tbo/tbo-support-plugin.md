# TBO Support plugin (`tbo.support`)

**Status:** proposal, with the read-only first version built alongside it. It follows the TBO Copilot architecture ([architecture.md](architecture.md), §6, §7.1 and §12).

**What it does:** lets the TBO Copilot agent read TBO Support tickets: the conversation, AI triage, fix brief, session replay, possible duplicates, the suggested reply, the estimate, and the knowledge base. A developer can ask: *"Summarise ticket 1234, show its fix brief and find similar tickets."*

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Where it fits](#2-where-it-fits)
3. [The picture](#3-the-picture)
4. [Components](#4-components)
5. [The tool and its actions (v1)](#5-the-tool-and-its-actions-v1)
6. [Later: write actions](#6-later-write-actions)
7. [Sign-in and secrets](#7-sign-in-and-secrets)
8. [Permissions in the app](#8-permissions-in-the-app)
9. [Handling ticket data safely](#9-handling-ticket-data-safely)
10. [Errors](#10-errors)
11. [Repository layout and build](#11-repository-layout-and-build)
12. [Testing](#12-testing)
13. [Using it on the server later](#13-using-it-on-the-server-later)
14. [What it needs from helpdesk](#14-what-it-needs-from-helpdesk)
15. [Build plan](#15-build-plan)
16. [Risks](#16-risks)
17. [Open questions](#17-open-questions)

---

## 1. Purpose and scope

| | v1 (this build) | Later |
|---|---|---|
| Reads | Tickets, conversation, internal notes, triage, fix brief, session replay timeline, duplicates, suggested reply, estimate, knowledge base | Customer, contract and SLA detail; tasks linked to a ticket |
| Writes | **None** | Internal notes, stage updates, draft replies, tasks (§6) |
| Where | TBO Copilot desktop app | Also the headless backend agent, through an MCP server (§13) |
| Who | The signed-in person, with their own TBO Support permissions | The same; the server uses a narrow service identity |

## 2. Where it fits

- **Architecture §7.1** defines the TBO Support plugin's Read / Change / Approval rules. v1 implements the Read column only.
- **Architecture §6** says each TBO capability is an MCP server. This plugin keeps that promise in two steps:
  - **Desktop now:** the plugin registers an **agent tool** (`contributes.agentTools`) that runs in the plugin's own Node process inside the app.
  - **Server later:** the **same tool code** is wrapped as an MCP server for the headless agent (§13).

  **Why not an MCP server on the desktop now:** a plugin's stdio MCP server must be a command on `PATH` or a native executable inside the plugin (`docs/plugin-development.md` §6.9), so every laptop would need Node installed or a separate binary per platform. An agent tool needs neither. It also gets the host's permission policy, audit log and 110-second timeout for free (§6.1 there).
- **Architecture §12, "core changes ideally nothing":** no PI-Desktop or helpdesk code changes. The plugin uses only the public plugin API and helpdesk's existing APIs.

## 3. The picture

```
TBO Copilot desktop app
 ├─ Agent (pi engine) ── calls the tool "tbo_support" (action = get_ticket, …)
 │                         │  host: permission policy · audit · 110 s timeout
 │                         ▼
 └─ Plugin process: tbo.support
      main.js ─► lib/actions.js ─► lib/helpdesk.js ─► pi.net.fetch ──HTTPS──► TBO Support
                     │                 (read-only allow-list)    token key:secret   (helpdesk APIs,
                     │                                                               the person's role)
                     └─► lib/shape.js: HTML to text, size caps, marks customer text as untrusted
      lib/credentials.js ─► macOS Keychain / Windows DPAPI   (the person's API key)
      renderer/index.html: sign-in panel

Later (§13):
 headless pi-host ──MCP──► server/mcp.js ─► the same lib/actions.js ─► TBO Support
```

## 4. Components

| File | Job |
|---|---|
| `manifest.json` | Declares the tool, three commands, the sign-in panel, the site setting, permissions and the one allowed host |
| `main.js` | Registers the tool and commands; answers the sign-in panel; builds a helpdesk client for each call |
| `lib/actions.js` | The actions: input checks, which helpdesk API each calls, and the shape of each result. Transport-neutral: no `pi.*` inside |
| `lib/helpdesk.js` | A small HTTP client for Frappe: URL building, the `token` auth header, a **read-only allow-list** of API paths, and error mapping |
| `lib/shape.js` | HTML to plain text, size caps, and the untrusted-content wrapper |
| `lib/credentials.js` | Saves, loads and removes the person's API key in the operating system's credential store |
| `renderer/index.html` | The sign-in panel: shows the site, takes the API key and secret, tests them, then saves them |

The plugin has **no npm dependencies**: plain CommonJS and Node built-ins only. So there is nothing to bundle, and the `pi-plugin pack` output is the source as written.

## 5. The tool and its actions (v1)

The plugin registers **one tool, `tbo_support`, with an `action` field**. The host shows it to the model under a plugin-namespaced name.

**Why one tool with actions:**
1. **Plan mode.** Plugin tools are hidden in Plan and Goal mode unless the tool lists `planSafeActions`, which needs an `action` enum (ADR 0211). Investigations run in Plan mode, so every read-only action is listed as plan-safe.
2. **Fewer tools for small models.** One tool with clear actions is easier for a flash model to pick than ten separate tools.

| Action | Returns | Helpdesk API | Inputs | Limits |
|---|---|---|---|---|
| `who_am_i` | The signed-in user and site | `frappe.auth.get_logged_user` | none | — |
| `list_tickets` | Recent tickets: number, subject, status, priority, customer, type, team, assignees, dates | REST `GET /api/resource/HD Ticket` | `status`, `customer`, `assigned_to_me`, `limit` | `limit` 1–50, default 20, newest first |
| `search_tickets` | Tickets matching words | `helpdesk.api.search.search` | `query`, `limit` | query 2–200 characters |
| `get_ticket` | Ticket fields, description, conversation, internal notes | `helpdesk.helpdesk.doctype.hd_ticket.api.get_one` | `ticket` | last 15 messages and 15 notes; 2,500 / 1,500 characters each |
| `get_triage` | AI triage: category, priority, complexity, summary, recommended track | `helpdesk.api.support_hub.get_triage` | `ticket` | — |
| `get_fix_brief` | The fix brief in Markdown | `helpdesk.api.fix_brief.get_fix_brief` | `ticket` | 30,000 characters |
| `get_session_replay` | Replay summary, diagnostics, timeline | `helpdesk.api.session_replay.get_session_replay` | `ticket` | timeline 12,000 characters; the replay file link is left out |
| `get_possible_duplicates` | Open tickets that look like the same request | `helpdesk.api.duplicates.get_possible_duplicates` | `ticket` | 10 items |
| `get_suggested_reply` | The AI suggested reply waiting on the ticket | `helpdesk.api.ai_suggestion.get_suggestion` | `ticket` | read only; never regenerates |
| `get_estimate` | Customization estimate: hours, status, dates | `helpdesk.api.customization.get_estimate` | `ticket` | — |
| `search_knowledge_base` | Articles matching words | `helpdesk.api.article.search` | `query` | query 2–200 characters |
| `get_article` | One article as plain text | `helpdesk.api.knowledge_base.get_article` | `article` | 20,000 characters |

**Input rules:**
- `ticket` accepts `1`, `#1`, `0001` or `HD-0001`. HD Ticket names are zero-padded to four digits (autoname `.####`: `0001`, `0042`, `12345`), so the number is padded the same way. If that name is not found, the plain number is tried once, for a site that names tickets without padding.
- Text inputs are trimmed and length-checked.
- Unknown inputs are refused by the schema (`additionalProperties: false`).

## 6. Later: write actions

Writes go in a **second tool, `tbo_support_write`**, so they are never plan-safe. They are `risk: "medium"`, so the host asks the person in Ask mode. Each one follows architecture §7.1:

| Action | Approval (architecture §7.1) |
|---|---|
| `add_internal_note` | None: internal only. Credited to the signed-in person |
| `set_stage` (templated customer updates such as "Working on it") | None: fixed, pre-written text |
| `draft_reply` | Draft only. Sending free text to a customer is part of the one change approval |
| `create_task`, `link_task` | None |

Each write action needs its own allow-list entry in `lib/helpdesk.js` (§9), its own tests, and a review against the helpdesk API it uses.

## 7. Sign-in and secrets

**v1 uses the person's own TBO Support API key.** Every call then runs as that person and only sees what their role allows. Helpdesk's APIs also refuse non-agents (`@agent_only`).

**Getting the key.** Frappe lets only a System Manager generate keys (`frappe.only_for("System Manager")` in `frappe/core/doctype/user/user.py`, `generate_keys`). So for v1 an admin opens the person's user → **API Access** → **Generate Keys** and hands the secret to that person directly. It is shown once. This is fine for a pilot with a few developers.

**Better sign-in, next:** "Sign in with TBO Support" through Frappe's OAuth provider.
- The plugin opens the browser. The person logs in as usual, with Microsoft login if the site has it. The plugin receives a token.
- It needs one **OAuth Client** record in TBO Support. That is configuration, not a helpdesk code change.
- The OAuth endpoints are already allowed by helpdesk's request filter (`helpdesk/auth.py`).

The other route is a small helpdesk PR: a "Connect TBO Copilot" button that generates the agent's own key. That is simpler code, but it is a change to the helpdesk app.

**Where the key lives:**

| Platform | Store | How |
|---|---|---|
| macOS | Keychain, service `tbo-copilot.tbo-support`, account = site host | `/usr/bin/security -i`, with the command sent on standard input, so the secret never appears in a process list |
| Windows | DPAPI (encrypted for the Windows user), file `credentials.dpapi` in the plugin's private data folder | PowerShell `ConvertTo-SecureString` / `ConvertFrom-SecureString`, with the secret sent on standard input |
| Other | Not supported in v1 | The app ships for macOS and Windows only |

**Why not plugin settings:** PI-Desktop does not allow secrets in plugin settings yet (D018; its validator rejects `secret: true`), and the host's own secret store is closed to plugins (`docs/spec/07-plugins/04-plugin-security.md`).

**The one deliberate exception:** `lib/credentials.js` starts `security` or `powershell` itself. That is a raw Node API rather than the host API, so the code is kept small, fixed (no input reaches the command line) and covered by tests. The proper fix is a host secret API for plugins, which we will propose upstream.

**Sign-in flow:**
1. Run **TBO Support: Sign in**. The panel opens.
2. Paste the key and secret.
3. The plugin first tests them with `who_am_i`, and saves them only if the test passes.

**Sign out** removes the saved key. Microsoft Entra sign-in replaces API keys later (architecture §10).

## 8. Permissions in the app

| Permission | Why |
|---|---|
| `agent.tool.register` | The `tbo_support` tool |
| `net.fetch`, with `net.domains: ["teams.teambackoffice.com", "localhost", "*.localhost", "127.0.0.1"]` | Calls to TBO Support, or to a local test bench on the same computer. The host refuses every other host, and re-checks redirects |
| `ui.panel` | The sign-in panel |

There is no file, shell, MCP or clipboard permission. The tool is `risk: "low"` because v1 only reads. The host audits every call. The plugin also logs each action and ticket number through `ctx.log`, never the content.

The **site address** is a plugin setting (`siteUrl`, default `https://teams.teambackoffice.com`). The plugin refuses an address whose host is not in `net.domains`. It also refuses plain HTTP, except for `localhost`, `127.0.0.1` and names ending in `.localhost`, which always mean this computer (RFC 6761). So a developer can test against a local bench site such as `http://tbo.localhost:8002`. The saved key is per host, so a local key and the real one never mix.

## 9. Handling ticket data safely

- **Customer text is untrusted.**
  - The description, messages, notes, fix brief, timeline and search snippets are wrapped in `<untrusted_ticket_content>…</untrusted_ticket_content>`.
  - Each result carries a note telling the model to treat that text as data, never as instructions.
  - A closing tag inside the text is altered, so the text cannot break out of the wrapper.
- **No side effects.**
  - `lib/helpdesk.js` only calls API paths on its read-only allow-list, and only with `GET`. Anything else throws before a request is made.
  - So v1 cannot write, regenerate an AI reply, or spend AI money on the site.
- **Size caps.**
  - Every text is clipped, with a note saying how much was cut.
  - Lists are capped.
  - Each result is also held under about 60,000 characters overall, dropping the oldest conversation items first.
- **HTML to text.** Messages are stored as HTML; the plugin converts them to plain text to save tokens.
- **Left out:**
  - the private replay file link;
  - avatars, view lists, form scripts and field metadata from `get_one`;
  - email `cc`/`bcc` lists.
- **Data to the model provider.** What the agent reads goes to the model the person selected. OpenAI's data terms must be confirmed before customer tickets are read with Luna (architecture §11).

## 10. Errors

| Situation | What the agent sees |
|---|---|
| Not signed in | "Not signed in to TBO Support. Run 'TBO Support: Sign in' from the command menu." |
| 401 | "TBO Support did not accept the API key. Sign in again." |
| 403 / `PermissionError` | "Your TBO Support account may not read this." |
| 404 / `DoesNotExistError` | "Ticket 1234 was not found." |
| 417 / 500 with a Frappe message | The Frappe message, shortened |
| 429 | "TBO Support is rate-limiting requests. Wait a minute and try again." The host never retries for the plugin |
| Network or timeout | "Could not reach TBO Support (…)." |
| Bad input | Exactly which input is wrong |

Errors are thrown as plain `Error`s with a `code`, so the host reports a failed tool call rather than a fake result.

## 11. Repository layout and build

```
tbo/plugins/
├─ tbo.support/
│  ├─ manifest.json
│  ├─ main.js
│  ├─ lib/{actions,helpdesk,shape,credentials}.js
│  ├─ renderer/index.html
│  └─ README.md
└─ tests/tbo.support/*.test.js     # node --test; kept outside the plugin so it is not packed
docs/tbo/tbo-support-plugin.md     # this document
.github/workflows/tbo-plugins.yml  # unit tests, pi-plugin check and pack
```

**Build and ship:**
1. CI (`tbo-plugins.yml`) runs the unit tests, `pi-plugin check` and `pi-plugin pack` on every plugin folder.
2. To ship it inside the installer, add `"tbo.support"` to `scripts/tbo/bundled-plugins.json`. The next `tbo-v…` release then includes it.
3. Developers can also load the folder directly: **Plugins → Load development plugin**. Hot reload picks up edits.

## 12. Testing

| Level | What |
|---|---|
| Unit (no network) | `lib/shape`: HTML to text, caps, wrapper escape. `lib/helpdesk`: URLs, auth header, allow-list refusal, error mapping from real Frappe error shapes. `lib/actions`: input checks, the result shape from recorded `get_one` output, the `assigned_to_me` filter. `lib/credentials`: the exact commands and stdin for macOS and Windows, using a fake runner. Manifest: the tool's action enum = `planSafeActions` = the code's actions |
| Plugin check | `pi-plugin check tbo.support` and `pack` (CI) |
| Manual in the app | Load the dev plugin → Sign in → ask the agent for `who_am_i`, a ticket, its fix brief, duplicates → try Plan mode → sign out → the agent gets "Not signed in" |
| Live | Against TBO Support with your own key. v1 cannot write, so this is safe |

**Local test site.** Add a helpdesk site to an existing bench with a name ending in `.localhost`, for example `bench new-site tbo.localhost` then `bench --site tbo.localhost install-app helpdesk`. Such a name points to this computer with no `/etc/hosts` line, and browsers do not force https on it. (A name like `tbo.new` cannot work, because browsers always force https for the real `.new` domain ending.) Set the plugin's address to `http://tbo.localhost:<port>`. Administrator counts as an agent in helpdesk (`is_admin()` in `helpdesk/utils.py`), and on your own site you can generate Administrator's API key yourself. Helpdesk asks for Frappe 15.109 or later, but it installed on a Frappe 15.84 bench here; a later helpdesk update may need newer Frappe.

## 13. Using it on the server later

- Add `server/mcp.js`, which wraps the same `lib/actions.js` as an MCP server (`@modelcontextprotocol/sdk`). It uses Node's `fetch` as the transport and runs over stdio for `pi-host`, or over HTTP for other clients.
- Credentials come from the server's secret store: a narrow service identity, never a person's key (architecture §10).
- This needs the headless MCP relay (architecture §5–§6). Until then the server agent cannot use it.
- Because `lib/actions.js` takes its transport and credentials as inputs, nothing in it changes.

## 14. What it needs from helpdesk

**No helpdesk changes.** The plugin uses these existing APIs. This list is the **contract** to share with the helpdesk maintainers, so a rename on their side is not a surprise:

| API | Permission check in helpdesk |
|---|---|
| `frappe.auth.get_logged_user` | Signed in |
| `GET /api/resource/HD Ticket` | Frappe list permissions |
| `helpdesk.api.search.search` | Signed in; the search index filters by access |
| `helpdesk.helpdesk.doctype.hd_ticket.api.get_one` | `has_permission("HD Ticket", "read")` |
| `helpdesk.api.support_hub.get_triage` | `@agent_only` |
| `helpdesk.api.fix_brief.get_fix_brief` | `@agent_only` + read permission |
| `helpdesk.api.session_replay.get_session_replay` | `@agent_only` + read permission |
| `helpdesk.api.duplicates.get_possible_duplicates` | `@agent_only` + read permission |
| `helpdesk.api.ai_suggestion.get_suggestion` | `@agent_only` + read permission |
| `helpdesk.api.customization.get_estimate` | Read permission |
| `helpdesk.api.article.search` | Signed in |
| `helpdesk.api.knowledge_base.get_article` | Non-agents see published articles only |


## 15. Build plan

| Step | Days |
|---|---|
| Architecture (this document) | 0.5 |
| `lib/` (shape, helpdesk client, actions, credentials) + unit tests | 1.5 |
| `main.js`, manifest, sign-in panel | 1 |
| Plugin check, CI test step, README | 0.5 |
| Manual test in the app + live test with a real key; fixes | 1 |
| PR to `tbo-copilot` to bundle it | 0.5 |
| **Total** | **about 5 days** |

## 16. Risks

| Risk | Mitigation |
|---|---|
| Helpdesk renames or changes an API | The contract list (§14); one client file to update; unit tests pinned to recorded shapes |
| Prompt injection through ticket text | Untrusted wrapper; v1 has no write actions at all; the host permission policy |
| Key leakage | OS credential store, never settings or logs; secret only on standard input; tested before saving |
| Large tickets fill the model's context | Per-field and per-result caps |
| Raw `child_process` in a plugin | Limited to `lib/credentials.js` with fixed commands; upstream secret API proposed |
| Windows path untested on a real machine | Test on a Windows laptop before release |

## 17. Open questions

1. Confirm the TBO Support address: `teams.teambackoffice.com`. It is the hub address used in helpdesk_client's tests.
2. Which task number covers this work? The PR needs `Closes TASK-…`.
3. Confirm OpenAI's data terms before reading customer tickets with Luna.
4. Should a staging TBO Support site be added to `net.domains` for testing?
5. API keys for the pilot: who generates them (a System Manager), and do we move to OAuth sign-in next or ask for a small self-service key PR in helpdesk (§7)?
