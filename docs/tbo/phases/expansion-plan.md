# Expansion: chat assistants for customers and staff, and CI/CD for every deployment (Phases 5–7)

**Status:** **approved by the owner 17 Oct 2026, order Phase 6 → 7 → 5** (decision 1). Each phase gets its detailed plan for approval before it is built; decisions 2–7 are confirmed in the phase that needs them. Asked for by the owner on 16 Oct 2026.
**Estimate:** about 40 developer-days in three phases, each with its own detailed plan before it is built.

## What was asked

1. **Customer chat assistant.** The customer raises a ticket by chatting. The assistant asks for the full problem,
   asks permission to record the screen, keeps talking with the customer openly, and when the cause is on the
   customer's side, explains kindly why it happened.
2. **Staff assistant in Teams and TBO Support.**
   - It tells the developer when TBO Copilot finished a task, and what was done, in short.
   - The developer can ask about the task, or ask for a change, and the assistant handles it.
   - The developer can approve by chat.
   - The developer can give it new work: the site name, images or videos of the issue.
   - It keeps reminding people of pending approvals.
3. **CI/CD for every code deployment.**

## What exists already

| Need | Already built | Gap |
|---|---|---|
| Customer raises a ticket in their ERP | helpdesk_client's Support button: a 5-step form (title, description, optional screen recording, screenshots), session replay, page context | A form, not a conversation; no follow-up questions |
| Customer website chat | TBO Chat (Chatwoot) bot inbox: AI answers from the knowledge base, raises a ticket, or hands to a person | Same brain should serve the ERP chat |
| Kind explanations | Copilot's diagnosis (customer_mistake, not_allowed_request) → an AI draft an agent sends | The assistant does not talk to the customer itself |
| Stages to the customer | Received → Working on it → Fix scheduled → Resolved, Confirm / Reopen | Shown on the ticket, not in a chat |
| Staff notifications | Teams through Workflows webhooks: one-way cards to a person or a channel | No replies, no buttons that act, no chat |
| Approvals and reminders | One approval per change, bound to the PR's head; reminders after N hours, escalation to a senior | Only one-way; nothing can be approved from Teams |
| Asking about work | The hub's MCP server (tickets, tasks, fix briefs, replays) used by the TBO Copilot desktop app | Not in Teams or the TBO Support web app |
| Deploys | Copilot fixes: approval → merge → Press deploy in the window → check after → undo by revert | Only for Copilot's fixes; CI is partial (Actions billing blocks private repos) |
| Microsoft sign-in | TBO Support's Entra app (Teams meetings, offboarding) with admin consent | No Azure Bot registration yet |

## The design in one picture

```
CHANNELS                                 TBO SUPPORT (the hub)                       TOOLS
customer's ERPNext ─ chat panel ──┐      ┌──────────────────────────────────┐
  (helpdesk_client Support button)│      │ Conversation engine (one, shared)│     hub MCP tools, as the person
TBO Chat website / WhatsApp ──────┼────► │  customer mode │ staff mode      │ ──► (tickets, tasks, runs, PRs,
  (Chatwoot bot inbox)            │      │  HDS Conversation + messages     │      approvals, site cards)
Teams ─ TBO Copilot bot ──────────┤      │  guardrails · audit · cost       │     customer ERP read through the
TBO Support web ─ Copilot panel ──┘      └──────────────┬───────────────────┘      connector (read-only)
                                                        │ the AI: call_haiku(job="chat"), Luna → Kimi
                                                        ▼
                         runs · approvals · deploys (as built) ── CI/CD pipeline (Phase 7)
```

One engine on the hub serves every channel, so the customer gets the same assistant in their ERP and on the
website, and staff get the same assistant in Teams and in TBO Support. Each channel is only a thin adapter.

## Phase 5: the customer support assistant (about 14 days)

**Where.** The Support button in the customer's ERP opens a chat panel instead of the form (the form stays as
"Send a form instead"). TBO Chat's bot inbox uses the same engine. Customers install nothing new: it ships in
helpdesk_client.

**The conversation.**
1. **Opens with context**, gathered without asking: the page and document the customer is on, their role, their
   recent errors on the site.
2. **Asks what a support engineer would:** what they tried, what they expected and what happened, which record,
   since when, one record or many, and whether it worked before.
3. **Asks permission to record the screen:**
   - it says exactly what is recorded and who sees it;
   - the browser's own permission prompt follows;
   - the recording is private to the ticket;
   - screenshots and files are also accepted.
4. **Shows a short summary** for the customer to confirm, then raises the ticket with structured fields (steps,
   expected and actual, records, recording) instead of one free-text box.
5. **Stays the place to talk:**
   - Copilot's stages appear as chat messages;
   - its questions come in the chat, and the customer's answers go back to the run;
   - Confirm or Reopen are buttons in the chat.
6. **When the cause is on the customer's side** (customer_mistake, not_allowed_request), it explains kindly:
   - what happened and why, from their own records (for example the document's version history);
   - the ERP way to correct it (for example cancel and amend);
   - how to prevent it, offered as an option.

   There is no blame. It never shows another customer's data.

**What the assistant may say on its own** (owner's decision 2):

| Message | Pilot | Later |
|---|---|---|
| Greeting, questions, recording request, summary, stage updates | itself | itself |
| Answers from the knowledge base or the customer's own settings (question) | itself above a confidence threshold, else an agent | itself |
| Explanations of a cause on the customer's side | an agent approves the draft in one click (today's card) | itself for categories proven right N times |
| Dates, prices, quotes, data changes, anything legal | never: a person | never: a person |

Always available: "Talk to a person", which hands over with the full transcript. The whole conversation is kept on
the ticket.

**Built from.**
- **Hub:**
  - `HDS Conversation` and its messages;
  - `helpdesk/copilot/conversation.py` (the engine, customer mode);
  - a signed endpoint for the customer site (per connection, HMAC with the pairing secret);
  - the engine's tools: knowledge base, the ticket, the run's status, read-only checks on the customer's site.
- **helpdesk_client:**
  - the chat panel (messages, typing, files, the recording button, stage messages, Confirm and Reopen);
  - the relay to the hub;
  - consent text for recordings.
- **TBO Chat:** the bot inbox calls the same engine.

**Guardrails:**
- the customer's text is untrusted (prompt injection);
- no secrets or other customers' data in answers;
- a rate limit per customer;
- a cost cap per conversation;
- languages: English first, Arabic next (decision 6).

## Phase 6: the staff assistant in Teams and TBO Support (about 16 days)

**Teams bot.**
- **Registration:** a single-tenant Azure Bot registered by TBO's Microsoft 365 admin, and the "TBO Copilot" Teams
  app installed for staff.
- **Hub endpoint:** `helpdesk.api.copilot_teams.messages`, with Bot Framework token checks.
- **Who is who:** people are matched to TBO Support agents by their Microsoft email.
- **Fallback:** the current Workflows webhooks stay as the fallback.

**What it does:**
1. **Tells people what Copilot did.**
   - When a fix is ready for approval, a card shows the problem, the cause, what changed (three lines), the
     checks, the sites and the risk, with **Approve**, **Reject (reason)** and **Open PR**.
   - It also posts when a fix is merged, deployed, checked, or failed, and when the customer confirms or reopens.
2. **Approves in the chat.**
   - The buttons call the same `decide` as the ticket page: bound to the PR's head, senior rule, first decision
     wins, `decided_via = Teams`.
   - A stale card says who decided first.
3. **Reminds until it is done.**
   - Pending approvals are repeated every N hours (a setting) as direct cards with buttons and Snooze (1 hour,
     until tomorrow).
   - They escalate to a senior or a manager after M hours, as today.
   - A morning digest lists what is waiting for each person.
4. **Answers questions about a task.** Examples: "What did Copilot change in TASK-2026-00123?", "Why this approach?",
   "Which sites get it?" Answers come from the run's events, the PR, the evidence and the checks, through the
   hub's MCP tools, with the person's own permissions.
5. **Takes change requests.**
   - "Use the price list rate instead" on a pending fix becomes the reject-with-note path: a follow-up fix run
     with that guidance, confirmed before it starts.
   - On a merged fix, it becomes a new follow-up run.
6. **Takes new work.** For example: "Alpha Trading: quotation discount wrong, see video", with images or a video
   attached.
   - It finds the site from the site cards and asks if unsure.
   - It confirms the customer, site and summary.
   - It raises the ticket, saves the attachments (videos become frames for the worker, as recordings do today),
     and starts Copilot's investigation.
   - Progress comes back in the same thread.
7. **Always acts as the person,** with their permissions. Every action is confirmed first and logged in HDS Copilot
   Call Log.

**TBO Support web:** the same assistant as a Copilot panel in the agent app, for people not in Teams.

## Phase 7: CI/CD for every deployment (about 10 days)

**CI on every pull request,** in every repository (helpdesk, helpdesk_client, the worker, the customer apps):
- lint;
- tests on a throwaway bench (GitHub Actions with a MariaDB service);
- the build;
- the AI review and the task reference check.

These are required checks before merge. Copilot's PRs also carry their sandbox evidence.

**Blocker to decide (decision 5):** GitHub Actions on TBO's private repositories is blocked by billing today.
Either add Actions minutes (or the Team plan), or run a self-hosted runner on the new worker server (cheap; only
TBO's own repositories; an isolated user).

**CD: one pipeline for every merge, not only Copilot's.**
1. A merge to a customer app's main branch opens a deploy request.
2. **Staging:** the change is deployed to the staging bench (the demo bench, later one per customer group) and the
   automatic checks run (the existing check after deploy).
3. **Approval:** one click in Teams or on the ticket.
4. **Production:** the Press deploy in the window.
5. **Check:** the check after deploy.
6. **Undo:** on failure, an automatic revert PR (as built for Copilot's fixes).

**Release record per deploy:** what changed, who approved, which sites, and the checks, plus a weekly report.

## Order and timeline (owner's decision 1)

**Recommended: Phase 6, then 7, then 5.**
- **Phase 6 first:** it is internal, builds on the approvals and reminders already there, and makes approvals
  faster at once.
- **Phase 7 next:** CI/CD is needed before more deploys run on their own.
- **Phase 5 last:** it faces customers, so it comes once the pilot has shown Copilot's diagnoses are right.

The alternative is Phase 5 first, if the customer experience is the business priority.

Before any of them: the Phase 2 checkpoint (the first real deploy on the demo sites) and the worker server.

## What TBO must provide

- **Microsoft 365 admin:** the Azure Bot registration and the Teams app approval for staff (Phase 6).
- **GitHub:** Actions minutes, or an OK for a self-hosted runner (Phase 7).
- **Customer-facing text:** recording consent and the assistant's greeting, approved by the owner (Phase 5).
- **Languages:** English, then Arabic? (Phase 5).
- **AI budget:** a monthly limit for chat (one OpenAI project key per channel group).

## Decisions for the owner

1. **Order:** Phase 6, then 7, then 5 (*recommended*), or customer chat first.
2. **What the customer assistant may say on its own:** the table above (*recommended*: intake, status and knowledge
   base answers on its own; explanations of the customer's own mistakes approved by an agent in one click during the
   pilot, then on its own per category once proven).
3. **Customer channels:** the ERP chat and TBO Chat sharing one engine (*recommended*), or the ERP chat only.
4. **Teams:** a two-way Azure Bot (*needed* for buttons and chat); who registers it.
5. **CI minutes:** GitHub Actions minutes or the Team plan, or a self-hosted runner on the worker server
   (*recommended*: the runner, if the owner accepts it on that server).
6. **Languages:** English first; Arabic next?
7. **The ERP AI assistant** (`erp_ai_assistant`, its own project) stays separate. A later link could let it hand
   "raise a ticket" to this chat.

## Risks

| Risk | Answer |
|---|---|
| The assistant says something wrong to a customer | Tiers above; agent approval for explanations in the pilot; "Talk to a person" always; transcripts kept |
| Prompt injection through a customer's message or a staff attachment | The text is treated as untrusted; tools are read-only for customers; actions need the person's confirmation |
| Approving by chat weakens the one approval | The same `decide` with the same checks (head-bound, senior rule, first wins); a card for a stale head is refused |
| Chat cost grows with volume | A cost cap per conversation and a monthly budget per channel; usage rows per job (TASK-2026-00012) |
| Teams bot needs Microsoft admin work | The Workflows webhooks stay as the fallback; Phase 6's chat in TBO Support works without Teams |
| CI on customer apps with almost no tests | Lint, migrate and the smoke checks still run; the agent's regression tests add coverage over time |
| Recording privacy | Explicit consent per recording, private files, retention limit, never shown to the AI in full (frames only) |
