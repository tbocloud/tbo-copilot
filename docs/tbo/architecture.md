# TBO Copilot architecture

**Status:** proposal for review (TASK-2026-00010). Later tasks build to this document and update it when a decision changes.

**What we are building:** TBO Copilot, an AI support engineer for Team Back Office. It takes a customer issue from investigation to a tested fix. **One person approves it from a short summary**, and every change is recorded outside the AI. It is built from:
- PI-Desktop's agent (this repository);
- TBO Support (`tbocloud/helpdesk`);
- the customer connector (`tbocloud/helpdesk_client`);
- TBO's own plugins.

## Contents

1. [Principles](#1-principles)
2. [The system at a glance](#2-the-system-at-a-glance)
3. [Who uses what](#3-who-uses-what)
4. [What already exists](#4-what-already-exists)
5. [Can the agent run without the desktop app?](#5-can-the-agent-run-without-the-desktop-app)
6. [How TBO capabilities are built: plugins and MCP](#6-how-tbo-capabilities-are-built-plugins-and-mcp)
7. [The five plugins](#7-the-five-plugins)
8. [From issue to fix: the flow and the one approval](#8-from-issue-to-fix-the-flow-and-the-one-approval)
9. [Traceability](#9-traceability)
10. [Authentication and permissions](#10-authentication-and-permissions)
11. [AI models](#11-ai-models)
12. [Where the code lives: core changes ideally nothing](#12-where-the-code-lives-core-changes-ideally-nothing)
13. [Where it runs](#13-where-it-runs)
14. [Build order](#14-build-order)
15. [Open questions](#15-open-questions)

---

## 1. Principles

| # | Principle | Meaning |
|---|---|---|
| 1 | **Few people, little of their time** | The AI does the investigation, fix and testing. People act only to approve, or when the AI cannot or should not continue. |
| 2 | **One approval, from a summary** | Every change to a customer's live system needs **one** approval by **one** person, given from a short summary in Teams. Automatic checks replace a second reviewer. |
| 3 | **The AI never changes a live system on its own** | Production changes happen only after that approval, through the normal deploy path. |
| 4 | **Every change is traceable outside the AI** | TBO Support, GitHub, Press, AWS and the customer's ERP each keep their own record (§9). |
| 5 | **Permissions follow the person** | Everyone signs in with their Microsoft (Entra) account and acts with their own role. There is **no shared master credential**; server identities are narrow and approval-gated (§10). |
| 6 | **No one has to install anything** | Teams and the browser are enough. The TBO Copilot desktop app is optional, for developers (§3). |
| 7 | **Core changes ideally nothing** | TBO features live in plugins, MCP servers and services, not in PI-Desktop's core, so upstream updates stay easy (§12). |

---

## 2. The system at a glance

```
                              Microsoft Entra ID  (one TBO sign-in, roles from groups)
                                       │
            ┌──────────────────────────┼───────────────────────────┐
            │                          │                           │
     Microsoft Teams           TBO Support (browser)      TBO Copilot desktop
     bot: chat, summaries,     tickets, tasks, approvals  (optional, developers)
     approvals                         │                           │
            └──────────────────────────┼───────────────────────────┘
                                       ▼
                      ┌────────────────────────────────────┐
                      │       TBO COPILOT BACKEND          │  central, always on
                      │  Teams bot · job queue · approvals │
                      │  model router · audit              │
                      │  ┌──────────────────────────────┐  │
                      │  │ Agent runtime (headless)     │  │  PI-Desktop's agent,
                      │  │ pi-host + host-core + sidecar│  │  no desktop UI (§5)
                      │  └──────────────┬───────────────┘  │
                      └─────────────────┼──────────────────┘
                                        │ MCP / tools (§6)
        ┌──────────────┬────────────────┼────────────────┬──────────────┐
        ▼              ▼                ▼                ▼              ▼
   TBO Support    Customer ERP     Customer Chat        AWS        Frappe Dev
   (helpdesk)     (helpdesk_client  (Chatwoot)       (infra, logs) (code, tests,
                   MCP on each site)                                GitHub, Press)
                        │                                                │
                        ▼                                                ▼
                customers' ERPNext sites                     GitHub PRs → Press deploy
```

---

## 3. Who uses what

| Person | Uses | Installs | Time per change |
|---|---|---|---|
| Customer | Their ERPNext (support button) or chat | Nothing new | Raise the issue; confirm or reopen |
| Approver (developer or lead on the rota) | **Teams** summary card | Nothing | About one minute to read and approve |
| Support agent, team lead | Teams + TBO Support | Nothing | Only on escalations |
| Developer (optional) | Desktop app for their own work, or to look deeper | Optional app | Only when they choose to |

The work runs on the central backend, so it continues when every laptop is closed. The desktop app adds power tools and never replaces the backend.

---

## 4. What already exists

TBO Copilot is built on these existing parts. The table was checked against `tbocloud/helpdesk` `main` at `e133655` and `tbocloud/helpdesk_client` `main` at `73478c2`.

| Capability | Where | How Copilot uses it |
|---|---|---|
| Tickets, tasks, SLA (TBO targets, Mon–Sat week), My Work, morning brief | helpdesk | Source of work, SLA clock, task tracking |
| **AI triage** (type, priority, complexity, cause; customization estimates) | `helpdesk/triage.py`, `api/customization.py` | First step of every ticket |
| **Fix brief**: a ticket as one Markdown brief for an AI coding agent, with safe-work rules (reproduce off production, open a PR) | `helpdesk/fix_brief.py` | The agent's starting instructions |
| **Approvals** of AI-proposed writes (risk levels, executed over MCP) | `helpdesk/approval.py` (HDS Support Action Request) | Basis of the one-approval flow |
| **Customer ERP connection**: paired sites, read tools, audited calls | HDS Support Connection, `helpdesk/mcp_client.py`, helpdesk_client `mcp/` | The Customer ERP plugin |
| Session replay, diagnostics, error logs from the customer's site | `helpdesk/session_replay.py`, client MCP `get_error_log` | Evidence for the investigation |
| **"TBO AI" user**: the hub's own work is credited to it, never to a person's account | `helpdesk/automation.py` | Traceability of every AI action |
| Customer chat (Chatwoot: AI first reply from the knowledge base, hand-off, ticket link) | `helpdesk/chatwoot_bridge.py` | The Customer Chat plugin |
| **Teams meetings** via Microsoft Graph (an Entra app with client credentials) | `helpdesk/teams_meetings.py` | TBO already has an Entra app registration |
| GitHub PR sync to tasks | `helpdesk/github_sync.py` | Links fixes to tickets |
| Shared AI review (Kimi) and task-reference checks | `tbocloud/ai-review`, each repository | The automatic review gate |
| TBO Copilot desktop app: TBO branding, CI installers, private plugins bundled | this repository, `tbocloud/tbo-copilot-plugins` | The optional developer client |

---

## 5. Can the agent run without the desktop app?

**Yes, with one important gap.** This was checked in the code of this repository (v0.16.1).

| Component | What it is | Needs the desktop UI? |
|---|---|---|
| `packages/agent-runtime` | The agent itself (the pi engine wrapper), run as a Node "sidecar" process | **No** |
| `packages/agent-host` | Turn queue, approvals, event log; pure logic with no I/O | **No** |
| `packages/host-runtime` | Starts and supervises host-core and the sidecar; "Electron-independent runtime layer" | **No** |
| `crates/host-core` | Rust host: database, built-in tools, permissions | **No** |
| `apps/pi-host` | A headless program that combines the above and serves them over **RACP** (JSON-RPC over WebSocket, loopback, device pairing): `session/create`, `turn/start`, `events/subscribe`, `approval/respond` | **No.** This is the headless agent |

**The gap.** The headless launch resolver (`packages/host-runtime/src/launch-resolver.ts`) is described in its own comment as the desktop's resolver *"minus the surfaces a headless machine does not have: **no plugin tools, no user MCP relay, no plugin agents**, no vendor OAuth accounts"*. It passes `pluginTools: []` and `trustedExtensions: []`.

Headless today **does** have:
- the built-in tools (Read, Write, Edit, Bash, Grep, Glob, TodoWrite);
- skills and subagents;
- providers with API keys;
- project instructions.

It does **not** have PI-Desktop plugins or MCP servers. Those run in the desktop app's Electron main process (`plugin-runtime.ts`, `user-mcp.ts`, `plugin-mcp.ts`).

**Consequence.** A Teams-driven backend can run the agent today, but it cannot reach TBO's tools if those tools exist only as desktop plugins. §6 resolves this.

**Live proof (pending).** Start `pi-host` with no app open, pair a test client over RACP, send a prompt, and receive the answer. The model is the local Ollama model on a developer Mac, so no API key is needed. The result is recorded here when it has run.

---

## 6. How TBO capabilities are built: plugins and MCP

**Decision.** Each TBO capability is an **MCP server**: a small service that offers tools under a standard protocol. Desktop plugins are optional extras for desktop-only UI (panels, the theme).

```
                  ┌──────────── TBO MCP servers (one per plugin, §7) ────────────┐
                  │ tbo-support · customer-erp · customer-chat · aws · frappe-dev │
                  └───────▲───────────────────────▲──────────────────────▲───────┘
                          │                       │                      │
              backend agent (headless)    desktop app (MCP support    Teams bot
              (needs the MCP relay,       exists in PI-Desktop)       (asks the backend)
               see below)
```

**Why MCP:**
- One implementation serves the server, the desktop app, and any other MCP client.
- MCP calls are permission-gated in PI-Desktop.
- The TBO Support hub already speaks MCP to customer sites.

**Closing the headless gap.** Recommended order:
1. **Contribute "MCP for headless hosts" upstream** to `vastsa/PI-Desktop`, so `pi-host` relays MCP servers the way the desktop does. This adds no permanent fork divergence and benefits upstream too.
2. Until it is merged, carry the same change as a small, documented patch in this fork. It is the only planned core change (§12).

**Alternatives considered:**

| Alternative | Why not |
|---|---|
| The backend runs its own agent loop instead of `pi-host` | Duplicates the agent engine |
| The agent calls TBO CLIs through Bash, with skills describing them | Works today, but weakens the permission model, because Bash commands are less controlled than typed tools |

---

## 7. The five plugins

Each plugin is an MCP server (§6) and keeps every call in an audit log.

**Read** = what the AI may see. **Change** = what it may do. **Approval** = what needs the one approval (§8).

### 7.1 TBO Support

Tickets, tasks, triage, fix briefs, approvals, meetings, SLA. Built on `tbocloud/helpdesk`.

| Read | Change | Approval |
|---|---|---|
| Tickets, conversation, attachments, session replay, triage, fix brief, SLA status, tasks, customer and contract, knowledge base | Internal notes; stage and status updates; draft replies; create and link tasks; propose approvals; schedule meetings | **None** for internal notes, stages and templated customer updates ("We're working on it", "Resolved"). **Included in the change approval** for any free-text reply to a customer. |

### 7.2 Customer ERP

Connects to each customer's ERPNext site through `helpdesk_client`'s MCP server and the paired connection.

| Read | Change | Approval |
|---|---|---|
| Allowed doctypes and records (masked samples, never bulk exports); metadata; customizations; error logs; reports; installed apps and deployed code (commit per app) | **Staging/UAT:** configuration and data fixes for allow-listed doctypes. **Production:** only the approved change set, applied by the deploy step | **Required** for every production write. The previous version of each changed document is saved first, for rollback. |

### 7.3 Customer Chat

The customer conversation in Chatwoot (website, WhatsApp). Built on the existing bridge.

| Read | Change | Approval |
|---|---|---|
| Conversations linked to a ticket; contact and customer | Knowledge-based first replies (existing, limited per chat, hands off to a person on doubt); stage messages | **None** for templated stage messages and existing KB replies. **Included in the change approval** for free-text answers about a fix. |

### 7.4 AWS

TBO's own infrastructure (servers, logs, deployments).

| Read | Change | Approval |
|---|---|---|
| EC2 and RDS status, CloudWatch logs and metrics, deployment and backup status | Proposals only: restart, scale, change configuration, deploy | **Required** for every change. Destructive or production-wide changes need a senior approver. The action runs with an approval-scoped role (§10). |

### 7.5 Frappe Dev

Frappe and ERPNext development, debugging and fixes in customers' custom apps.

| Read | Change | Approval |
|---|---|---|
| The custom app at the **commit deployed** on the customer's site (GitHub); Frappe/ERPNext sources; test results | Code changes in an **isolated sandbox bench**; tests, `bench migrate` and checks there; a branch `copilot/<ticket>` and a **pull request** | **Required** before merge and deploy. The PR, the CI results and the AI review are part of the summary. |

---

## 8. From issue to fix: the flow and the one approval

```
1. Issue arrives          customer's ERP support button, chat, or email      people: none
2. Triage                 type, priority, SLA, fix brief (TBO Support)       people: none
3. Investigate and fix    backend agent: reproduce, find the cause, fix      people: none
                          in a sandbox (Frappe Dev, Customer ERP read)
4. Automatic checks       tests · bench migrate · AI review (Kimi) ·         people: none
                          risk rules · deploy to the customer's UAT and
                          check it automatically
5. ONE APPROVAL           summary card in Teams → Approve / Reject / Ask     people: one, ~1 minute
6. Deploy                 merge + Press deploy (or the approved change set); people: none
                          automatic verification; automatic rollback on failure
7. Close                  customer told "Resolved", can confirm or reopen    people: none
```

### The summary card

```
🔧 Fix ready: HD-1234 · Galom · "Sales Invoice won't save"
Problem:  Saving fails when the customer has no tax ID.
Cause:    Custom validation in galom_app reads an empty field.
Fix:      Skip the check when the field is empty (1 file, 4 lines).
Risk:     Low · no accounts, stock or permission changes
Checks:   ✅ tests  ✅ AI review  ✅ UAT check
Deploys:  galom.erp (production) tonight 22:00 · automatic rollback
[ Approve ]  [ Reject ]  [ Ask ]  [ Details ↗ ]
```

### Who approves

- **One person** from the approver rota: the developer assigned to the customer, else the team's on-duty approver.
- No answer within the SLA window: the card moves to the team lead. This is a **backup**, not a second approval.

### Automatic checks replace the second reviewer

| A second person used to | Now done by |
|---|---|
| Review the code | AI review (Kimi), automated tests, deterministic risk rules on the real diff |
| Test on UAT | Automatic deploy to UAT and automatic checks there (pages load, no new errors, the reported case now works) |
| Watch the deploy | Automatic verification and rollback |

### When a person takes over (exceptions only)

- The AI cannot reproduce or fix the issue, or its confidence is low.
- **Sensitive areas:** accounting, payments, stock valuation, payroll and tax, permissions, database migrations or patches, integrations. The one approver must then be a **senior**: still one person.
- Tests fail after retries, the budget runs out, or the SLA is at risk.
- The customer reopens after "Resolved".

**Accepted trade-off.** Without a human test on UAT, a change that is technically correct but wrong for the customer's business can reach production. The safety nets are:
- the sensitive-area rule;
- automatic rollback;
- the customer's Reopen button, which always escalates.

---

## 9. Traceability

Every change leaves a record **outside the AI**, so these questions can always be answered: what changed, why, who approved it, when it went live, and how to undo it.

| System | Record |
|---|---|
| **TBO Support** (the ticket) | The story: issue, AI summary, the approval (**who and when**), deploy result, customer confirmation. AI actions are credited to the **"TBO AI"** user. |
| **GitHub** | The exact code change: branch, pull request (with the ticket reference and the approver), CI and AI review results, merge commit. |
| **Press** | Which version was deployed to which site, when, and the backup taken before. |
| **Customer's ERPNext** | Frappe's **Version** history on each changed document (who, what, before and after); the change set saved before the deploy. |
| **AWS** | CloudTrail records every infrastructure action under the approval-scoped role. |
| **MCP audit log** | Every tool call the AI made on a customer site (HDS Remote Audit Log). |

```
HD-1234 ──► PR #57 (code, checks, "approved by <name>") ──► Press deploy #312 ──► galom.erp
   ▲                                                                              │
   └────────────── "Resolved · deployed 22:00 · approved by <name>" ◄─────────────┘
```

---

## 10. Authentication and permissions

### Sign-in

```
person ──► Microsoft Entra ID ──► TBO Copilot (desktop, Teams bot, TBO Support)
                                        │
                                person's identity + Entra groups
                                        │
                                TBO role ──► allowed plugins and actions
```

- **One sign-in.** The desktop app and TBO Support use Entra sign-in. The Teams bot receives the person's Entra identity from Teams.
- **Roles from Entra groups:**

  | Entra group | Role | Can |
  |---|---|---|
  | TBO Support | Support agent | Read tickets, chat, approve customer replies |
  | TBO Developers | Developer / approver | Approve fixes for assigned customers |
  | TBO Leads | Team lead | Senior approvals, reassignment |
  | TBO Admins | Admin | Configuration |

- TBO already has an Entra app registration for Microsoft Graph (Teams meetings, `helpdesk/teams_meetings.py`). Copilot adds a sign-in app and a bot registration in the same tenant.

### Credentials: no shared master key

| Who acts | Credential | Scope |
|---|---|---|
| A person in the **desktop app** | **Their own:** their GitHub account; AWS through IAM Identity Center federated from Entra (their own role) | Exactly what that person may do |
| The **backend agent** (reading, investigating) | Narrow service identities: a GitHub App limited to `copilot/**` branches and pull requests; per-site customer MCP keys (least privilege); a **read-only** AWS role | Read and propose; never merge, deploy or change infrastructure |
| An **approved action** (deploy, AWS change) | A short-lived credential issued **for that action**: Press API, an AWS action role assumed per approved change | One action; recorded with the approver's identity |
| **Model providers** | API keys held only by the backend (never in the agent sandbox or the desktop) | Model calls only |

Secrets live in the backend's secret store and GitHub Actions secrets, never in repositories. The AI's sandbox has no credentials at all.

---

## 11. AI models

```
              TBO Copilot
                   │
             MODEL ROUTER   (one config: job → model)
     ┌──────────┬──┴────────┬────────────┐
   fast jobs  coding     complex jobs   review
 (triage,     (fix,      (investigate)  (check the work)
  summaries,   tests)
  chat)
```

- **Which models** comes from the separate multi-LLM task. Its version 1 decision is **one fast, low-cost model, OpenAI GPT-5.6 Luna, for every job**. Adding a model later (for example DeepSeek or GLM) is a config change.
- **One job→model map** shared by the backend, the desktop app and TBO Support (HDS Hub Settings already holds the triage and investigation models).
- **Review step:** a separate, strict reviewer call checks each fix before the summary is sent. It runs in addition to Kimi's PR review.
- **Retries:** two attempts, then a person.
- **Cost:** tokens and cost per run, job, model and customer, logged to HDS AI Usage Log and HDS Model Pricing.
- **Customer data:** prompts carry the ticket, the relevant code and small masked samples, never bulk records. The provider's data-use and retention terms are recorded before customer data is sent.

---

## 12. Where the code lives: core changes ideally nothing

| Repository | Contains | Visibility |
|---|---|---|
| `tbocloud/tbo-copilot` (this fork) | PI-Desktop + **minimal TBO changes**: branding script, update switch, CI installers, docs. **Planned:** the headless MCP relay (§6), ideally merged upstream instead | Public (LGPL) |
| `tbocloud/tbo-copilot-plugins` | Desktop plugins (`tbo.theme` today) and, later, the five MCP servers | Private |
| TBO Copilot backend (new repository) | Teams bot, job queue, approvals, model router, audit; runs `pi-host` | Private |
| `tbocloud/helpdesk` | TBO Support: ticket flow, approvals, summary cards, traceability records | Existing |
| `tbocloud/helpdesk_client` | Customer connector: MCP tools, write allow-list, code identity | Existing |

**Rule.** A TBO feature goes into a plugin, an MCP server, the backend or TBO Support, never into PI-Desktop's own files. Any unavoidable core change is:
- listed in `docs/tbo/README.md`;
- offered upstream first.

---

## 13. Where it runs

| Part | Runs on |
|---|---|
| TBO Copilot backend + headless agent + sandbox benches | A TBO server (Linux, Docker), always on |
| TBO Support | TBO's Frappe site |
| Customer sites (production and UAT) | Press |
| Desktop app (optional) | Developers' laptops (macOS, Windows), from the GitHub releases of this repository |
| Teams bot | Microsoft Teams, calling the backend |

---

## 14. Build order

| # | Step | Outcome |
|---|---|---|
| 1 | Headless proof (§5) and the MCP relay for headless hosts (§6), upstream first | The agent runs on a server with TBO tools |
| 2 | **TBO Support MCP** and **Customer ERP MCP** (read first) | The agent can investigate real tickets |
| 3 | Backend v1: job queue, summary card in Teams, one approval, traceability records | The core loop works end to end, for read-only and investigation work |
| 4 | **Frappe Dev MCP**: sandbox bench, tests, branch and PR | Code fixes up to the approval |
| 5 | Deploy step: Press, change sets, verification and rollback | Approved fixes reach production |
| 6 | **Customer Chat** and **AWS** MCPs | Full coverage |
| 7 | Entra sign-in everywhere, roles, approval-scoped credentials | Permissions follow the person |

---

## 15. Open questions

1. Who is on the **approver rota**, and what is the approval time limit before the team lead is asked?
2. Confirm the **sensitive areas** that need a senior approver (§8).
3. **Where the backend runs**: a TBO AWS server or another host?
4. Is the **Luna model ID and data terms** confirmed (multi-LLM task)?
5. **Entra:** who creates the sign-in app and the bot registration, and which groups map to which roles?
6. **Upstream:** is contributing the headless MCP relay to `vastsa/PI-Desktop` acceptable?
7. **GitHub plan:** rulesets are not enforced on private repositories on the Free plan (`tbo-copilot-plugins`, `helpdesk_client`). Upgrade, or rely on convention?
