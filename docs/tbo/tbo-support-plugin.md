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
                     │                 (read-only allow-list)    Bearer token       (helpdesk APIs,
                     │                                           (or an API key)     the person's role)
                     └─► lib/shape.js: HTML to text, size caps, marks customer text as untrusted
      lib/desktop.js ─► TBO Support's desktop sign-in (tbo_desktop.api): code, Allow, tokens, renewal
      lib/credentials.js ─► macOS Keychain / Windows DPAPI   (the sign-in session, or an API key)
      pi.providers ─► the "TBO AI" provider row: address and key from the sign-in
      renderer/index.html: sign-in panel

Later (§13):
 headless pi-host ──MCP──► server/mcp.js ─► the same lib/actions.js ─► TBO Support
```

## 4. Components

| File | Job |
|---|---|
| `manifest.json` | Declares the tool, three commands, the sign-in panel, the site setting, the **TBO AI** provider (no address: the sign-in sets it), permissions and the one allowed host |
| `main.js` | Registers the tool and commands; answers the sign-in panel; builds a helpdesk client for each call |
| `lib/actions.js` | The actions: input checks, which helpdesk API each calls, and the shape of each result. Transport-neutral: no `pi.*` inside |
| `lib/helpdesk.js` | A small HTTP client for Frappe: URL building, the auth header (the sign-in's bearer token, or `token key:secret`), a **read-only allow-list** of API paths, and error mapping |
| `lib/desktop.js` | The Microsoft sign-in through TBO Support: start (a code and the Allow page), wait for Allow, renew, sign out |
| `lib/shape.js` | HTML to plain text, size caps, and the untrusted-content wrapper |
| `lib/credentials.js` | Saves, loads and removes the sign-in session (or an API key) in the operating system's credential store |
| `renderer/index.html` | The sign-in panel: **Sign in with Microsoft**, the code while it waits, who is signed in and whether TBO AI is ready; an API key form for a local test site |

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

**People sign in with their Microsoft work account (TBO Copilot Phase 17).** Nobody types a key: TBO Support's
desktop sign-in gives this computer what it needs, and every call still runs as that person, seeing only what
their role allows.

**The flow:**
1. **TBO Support: Sign in** opens the panel; the person presses **Sign in with Microsoft** (the panel also opens
   by itself at start when nobody is signed in).
2. The plugin asks TBO Support for a code (`tbo_desktop.api.start_sign_in`, sending the computer's name and
   system) and opens the browser at TBO Support's Allow page. It opens only a page on the same site.
3. The person logs in with Microsoft. The page shows the computer's name and the same code as the panel, and they
   press **Allow**.
4. The plugin waits (`finish_sign_in`, every few seconds, at most 10 minutes) and gets, once:
   - a computer token (30 days);
   - a TBO Support token (a Frappe bearer token, 12 hours);
   - the person's TBO AI key and the gateway's address.
5. The plugin puts the AI key and address into its **TBO AI** provider row (`pi.providers.setCredential` and
   `setBaseUrl`). The app holds the key in its own secret store; the plugin cannot read it back and never stores
   it itself.
   - A new address never sees the old key: the plugin clears the row, sets the address, then the key, so a
     failure half way leaves no key rather than a mixed pair.
   - The app accepts the address only on a host in the plugin's `net.domains` (the gateway,
     `copilot-gateway.tbocloud.in`, is listed for that and is never accepted as a TBO Support address).
   - The model picker refreshes as soon as the key is set.
   - The row holds one site's key: changing the site address clears it at once, and the new site's sign-in (if
     any) sets it again. At start the row is cleared first (a key from an earlier run belongs to no known sign-in)
     and the renewal sets it; if that renewal fails, the next panel read, check or tool call tries again.
   - The app checks the address again whenever a chat starts, against the plugin's `net.domains` at that moment.
   - If the app refuses the key, the panel says so and the plugin tries again within about 5 minutes.
6. While signed in, the plugin renews the TBO Support token before it runs out (`refresh`), at start and when a
   call is refused. TBO Support checks the person again each time. If TBO Support cannot be reached for a routine
   renewal, the plugin keeps using the saved token until it actually runs out.

**Overlapping steps.** Every sign-out, API-key sign-in and site change makes a renewal or Microsoft sign-in that is
still running drop its answer (a Microsoft sign-in overtaken while it starts opens no browser), and all writes to the saved sign-in and the TBO AI row happen one at a time. So a renewal
can never put a key back after sign-out, a cancelled sign-in keeps nothing, and the panel never shows a sign-in
whose TBO AI is still being set up. An API-key sign-in is refused while a Microsoft sign-in is kept for that site.

**When TBO Support ends the sign-in** (the person lost access, the 30 days are over, a System Manager signed the
computer out), renewal answers 401. The plugin then removes the session and clears the TBO AI key, and tells the
person why.

**Sign out** tells TBO Support (which revokes the token and removes the AI key), clears the TBO AI key on this
computer, then removes the saved sign-in. If the Keychain or the data folder refuses the removal twice, sign-out
says so ("this computer could not delete the saved sign-in") instead of reporting success. If TBO Support cannot be
reached, sign-out still completes on this computer and says that the sign-in there (and the TBO AI key on the
gateway) ends only when a System Manager ends it in TBO Desktop Sign-in, or when it runs out.

**Check connection** asks TBO Support who is signed in, so it reports a revoked sign-in or an unreachable site
instead of trusting the saved token.

**A local test site** (`localhost`, `127.0.0.1`, `*.localhost`) can still use an API key: the panel offers the
form only there. Frappe lets only a System Manager generate keys (`generate_keys`). On your own site you can
generate Administrator's key yourself.

**Where the secrets live:**

| Platform | Store | How |
|---|---|---|
| macOS | Keychain, service `tbo-copilot.tbo-support`: account `session.<site>` for the sign-in, `<site>` for an API key | `/usr/bin/security -i`, with the command sent on standard input, so the secret never appears in a process list |
| Windows | DPAPI (encrypted for the Windows user): files `<site>.session.dpapi` and `<site>.credentials.dpapi` in the plugin's private data folder | PowerShell `ConvertTo-SecureString` / `ConvertFrom-SecureString`, with the secret sent on standard input |
| Other | Not supported | The app ships for macOS and Windows only |

`<site>` is the host name for an https site on the standard port (for example `teams.teambackoffice.com`), and
`scheme_host_port` for any other address (for example `http_tbo.localhost_8002`), so two local benches on one host
never share a sign-in. An API key saved before this rule for a local bench is not read again: enter it once more.

The session (computer token, TBO Support token, who is signed in) travels as one base64url word, at most 8,192
characters; a longer one is refused when it is saved rather than lost when it is read. The TBO AI key is never part
of it: it lives only in the app's provider row.

**Why not plugin settings:** the app does not allow secrets in plugin settings (D018), and its own secret store is
open to plugins only for the key of a provider row the plugin owns (ADR 0319).

**The one deliberate exception:** `lib/credentials.js` starts `security` or `powershell` itself. That is a raw
Node API rather than the host API, so the code is kept small, fixed (no input reaches the command line) and covered
by tests.

## 8. Permissions in the app

| Permission | Why |
|---|---|
| `agent.tool.register` | The `tbo_support` tool |
| `net.fetch`, with `net.domains: ["teams.teambackoffice.com", "demo-tbo.tbocloud.in", "copilot-gateway.tbocloud.in", "localhost", "*.localhost", "127.0.0.1"]` | Calls to TBO Support (the real site or the demo hub), or to a local test bench on the same computer. The gateway is listed because the app checks the TBO AI address against `net.domains`; the plugin never sends a TBO Support token there. The host refuses every other host, and re-checks redirects |
| `ui.panel` | The sign-in panel |
| `shell.openExternal` | Opens TBO Support's Allow page in the browser (only a page on the same site) |
| `provider.register` | The **TBO AI** provider row, and storing its key and address after the sign-in |

There is no file, command, MCP or clipboard permission (`shell.openExternal` only opens the Allow page). The tool is `risk: "low"` because v1 only reads. The host audits every call. The plugin also logs each action and ticket number through `ctx.log`, never the content.

The **site address** is a plugin setting (`siteUrl`, default `https://teams.teambackoffice.com`). The plugin refuses an address whose host is not in `net.domains`. It also refuses plain HTTP, except for `localhost`, `127.0.0.1` and names ending in `.localhost`, which always mean this computer (RFC 6761). So a developer can test against a local bench site such as `http://tbo.localhost:8002`. The saved sign-in and key are per site (scheme, host and port), so a local key and the real one never mix.

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
| 401 | "TBO Support did not accept your sign-in. Run 'TBO Support: Sign in' again." (with a sign-in, the plugin first renews once) |
| The sign-in ended | "Your TBO sign-in ended: <TBO Support's reason>" as a notice; the session and the TBO AI key are removed |
| 403 / `PermissionError` | "Your TBO Support account may not read this." |
| 404 / `DoesNotExistError` | "Not found in TBO Support." followed by the shortened detail |
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
