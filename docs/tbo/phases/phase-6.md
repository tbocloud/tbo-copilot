# Phase 6: the staff assistant in Teams and TBO Support

**Status:** plan written 18 Oct 2026; **approved by the owner 18 Oct 2026 with every recommended decision**; building. **Estimate:** about 16 developer-days:
H17 (the conversation engine, ≈ 4), H18 (the Teams bot, ≈ 4), H19 (approvals, reminders and the digest in Teams,
≈ 3), H20 (the Copilot panel in TBO Support, ≈ 2), W9 (images and videos reach the worker, ≈ 2), and the live test on
the demo hub (≈ 1). **Design reference:** `expansion-plan.md` (approved 17 Oct, order 6 → 7 → 5), `system-design.md`
§5.6 (Teams bot with buttons). **Built on:** Phases 0 to 4 (helpdesk `tbo-copilot`, the worker in its pull requests
and #13).

## Goal

TBO's people work with Copilot where they already are, in Teams (or the TBO Support web app):

- Copilot tells the developer when a fix is ready, merged, deployed or reopened, in a few lines.
- They approve or reject from the card, ask about a task ("what did Copilot change in TASK-2026-00123, and why?"),
  ask for a change ("use the price list rate instead"), or give new work ("Alpha Trading: quotation discount wrong",
  with a screenshot or a video).
- Pending approvals keep coming back until someone decides, and each morning everyone sees what waits for them.

Every action is the person's own, with their permissions, confirmed with a button first, and logged.

## What exists today, and what it means for this phase

| Found (18 Oct) | Consequence |
|---|---|
| Teams messages go out through **Workflows webhooks** (`chat_notifications.py`): one-way cards to a person or a channel, posted by the Flow bot | Nothing can be answered or pressed in Teams. A real bot (Azure Bot) is needed for buttons and replies. The webhooks stay as the fallback |
| TBO Support already signs in to Microsoft: tenant ID in HD Settings, a **Connected App** with client credentials for Graph (Teams meetings, offboarding) | The bot gets its own app registration (a bot's identity is separate), in the same tenant; the admin who gave consent for the meetings app does this one too |
| **Approvals** (`approvals.decide`): bound to the PR's head, senior rule, first decision wins, `decided_via`; reminders and escalation every N/M hours through `notify_users` | The Teams buttons call the same `decide` with `decided_via = Teams`; reminders become cards with buttons for people the bot can reach |
| The hub's **AI** answers one prompt at a time (`call_haiku`, JSON); the only tool loop is the older investigation feature, which stays untouched | The assistant is an **intent reader plus fixed actions** (below), not a model that runs tools on its own: the model reads what the person wants, the code does it after their confirmation |
| The **hub's MCP tools** (`tools_read`, `tools_write`) already answer "my work", tickets, tasks, fix briefs, runs, with the caller's permissions | The assistant reuses them as plain functions, as the person |
| The worker gets a ticket's **file list only** (`run_context.files`: names and URLs), not the images or any frames; session replays are separate | New work with a screenshot or a video needs W9: the worker downloads a ticket's images through the hub and turns a video into a few frames it can look at |
| Customers, sites and apps are on the **site cards** (HDS Site Registry) | "Alpha Trading" is found on the cards; when two match, the assistant asks |

## Decisions in this plan (please confirm)

| # | Topic | This plan | Why |
|---|---|---|---|
| 1 | Where the bot talks | **Personal chat with each person** in v1; team channels keep the Workflows webhook posts | Approvals and questions are personal; a channel bot adds noise and permission questions |
| 2 | Who registers it | TBO's **Microsoft 365 admin** creates a single-tenant app registration and an Azure Bot (the free tier; Teams is a standard channel, so its messages cost nothing), and approves the "TBO Copilot" Teams app | Only an admin can; about an hour with the steps we send |
| 3 | Reaching everyone | The admin **installs the app for all TBO staff** through a Teams setup policy, so the bot can start a chat with anyone (reminders need it). People without it still get today's webhook messages | Without an install, a bot can only answer people who wrote to it first |
| 4 | How the assistant works | **Intent reader + fixed actions**: the model (Luna, job `chat`) turns a message into one intent with its details (question, approve, reject with a reason, change request, new work, what waits for me, snooze); the code does it after a confirmation button; answers to questions are written only from the run's own record (diagnosis, evidence, checks, PR, events) | Predictable and safe: the model cannot act on its own, and every answer has a source |
| 5 | New work from chat | The ticket is **raised by the person for the customer** (customer from the site card), with the attachments; the customer is not emailed until an agent replies; Copilot's investigation starts at once (at the customer's Copilot level) | Staff often hear about problems by phone or WhatsApp; this puts them in the system in one message |
| 6 | Change requests | On a pending fix: the reject-with-note path, so a **follow-up fix run** gets the guidance; on a merged fix: a new follow-up run. Always confirmed first | The path exists and is audited; the chat only makes it easier |
| 7 | Reminders | Every **approval reminder** becomes a card with Approve, Reject and **Snooze** (1 hour, until tomorrow 09:00); a **morning digest** at 09:00 Riyadh to each person with something waiting | "Keeps reminding until it is done", without nagging at night |
| 8 | The web panel | The same assistant as a **Copilot panel** in TBO Support (agent app), for people not in Teams | One engine, two channels; little extra work |
| 9 | Language | **English**; the assistant answers in English even when asked in another language, for now | Arabic comes with Phase 5's customer assistant |

## What you will see at the end

- A developer gets a Teams message from **TBO Copilot**: "Fix ready for ticket 0101 (Alpha Trading): a
  calculation used the wrong value; 2 files changed; tests and checks passed; deploys to alpha site; risk low", with
  **Approve**, **Reject**, **Open PR**. They press Approve; the card changes to "Approved by Meera at 10:42";
  a colleague's copy of the card says the same.
- They type "why did it change the tier lookup?" and get three lines from the diagnosis and the evidence, with a
  link to the PR.
- They type "use the price list rate instead" on a pending fix; the bot asks "Reject this fix and ask Copilot for a
  new one with: use the price list rate instead?"; they press Yes; a follow-up fix run starts.
- They send "Beta Services: visit planning shows yesterday's visits" with a screenshot; the bot answers "Raise a
  ticket for Beta Services (beta site) with this screenshot, and let Copilot investigate?"; Yes; 3 minutes later the
  diagnosis arrives in the same chat.
- At 09:00 each person with something waiting gets one digest; an approval unanswered for 4 hours comes back with
  Snooze; after 24 hours it goes to a senior, as today.
- The same chat works in TBO Support's Copilot panel.

## What changes, part by part

### H17 (helpdesk): the conversation engine (≈ 4 days)

| Item | Detail |
|---|---|
| Doctypes | **HDS Copilot Chat** (one per person and channel: user, channel Teams or Web, last activity) and **HDS Copilot Chat Message** (chat, direction, text, attachments, intent, action, card state, cost); kept 90 days |
| Intents | `call_haiku(job="chat")` with the person's message, the last few messages and what is on their plate (pending approvals, recent runs): JSON `{intent, ticket/task/run, reason, customer, site, summary}`. Intents: `question`, `approve`, `reject`, `change_request`, `new_work`, `waiting`, `snooze`, `help`, `unclear` |
| Answers | A question about a ticket, task or run is answered from that run's record only (diagnosis, evidence, proposal, checks, PR title and changed files, events), with links; "I don't know" when it is not there |
| Actions | Each action is a **confirmation card** first (what will happen, Yes / Cancel); Yes calls the existing code as the person: `approvals.decide`, the reject-with-note follow-up, `start_run`, the ticket insert, snooze |
| As the person | `frappe.set_user` to the matched agent for the action; their permissions decide; refused actions say why |
| Audit | Every message, intent and action in the chat log; every action also in HDS Copilot Call Log (`via` Teams or Web); AI cost under job `chat` |
| Limits | 30 messages a minute per person; attachments up to 10 per message, 50 MB each |

### H18 (helpdesk): the Teams bot (≈ 4 days)

| Item | Detail |
|---|---|
| Endpoint | `helpdesk.api.copilot_teams.messages` (POST, public): checks the Bot Framework token (signature from the published keys, issuer, audience = our bot's app ID, the service URL) and the tenant (ours only); everything else is refused |
| Settings | HDS Copilot Settings → Teams: bot app ID, client secret (Password), tenant (from HD Settings), enabled; **Test** sends a card to yourself |
| People | **HDS Teams User**: Microsoft user ID, email, the agent it maps to (by email; unknown people get a polite "ask your manager"), the conversation reference for proactive messages |
| Sending | Bot Framework REST with a client-credentials token; cards as Adaptive Cards 1.5; card buttons are **Universal Actions** (`Action.Execute`), so the card updates in place and shows the same state to everyone it was sent to |
| Files | Images and files sent to the bot are downloaded with the bot's token and attached to the ticket (new work) |
| Fallback | No bot, or no reference for a person: today's Workflows webhook message, unchanged |
| Teams app | The manifest (`helpdesk/copilot/teams/manifest/`, icons, personal scope, `supportsFiles`) zipped for the admin |

### H19 (helpdesk): approvals, reminders and the digest in Teams (≈ 3 days)

| Item | Detail |
|---|---|
| Fix ready | When an approval opens: a card to the approver (problem, cause, the change in three lines, checks, sites, risk; Approve, Reject with a reason, Open PR) |
| Follow-ups | Short cards when the fix is merged, deployed, checked or failed, and when the customer confirms or reopens: to the approver and the ticket's assignee |
| Reminders | `remind_and_escalate` sends the card again with **Snooze**; a snooze (per person and approval) holds the reminder; escalation is unchanged |
| Digest | 09:00 Riyadh: one card per person with their pending approvals, their fix tasks in progress and anything reopened |
| Stale cards | A card pressed after someone else decided shows "Approved by X at T" (first decision wins, as on the ticket page) |

### H20 (helpdesk): the Copilot panel in TBO Support (≈ 2 days)

A slide-over panel in the agent app (the Copilot button in the top bar): the same engine through
`helpdesk.api.copilot_chat.send(message, files)`; cards drawn in the app with the same actions; the chat follows the
person between Teams and the web.

### W9 (worker): images and videos reach the worker (≈ 2 days)

| Item | Detail |
|---|---|
| Hub | A worker tool `get_ticket_file(name)`: one file of the run's ticket (images and videos only, up to 50 MB), lease-checked |
| Worker | Downloads the ticket's images into `context/files/`; a video becomes up to 12 frames at scene changes plus a contact sheet (`ffmpeg`, added to the worker image) in `context/frames/`; INDEX.md lists them; the model looks at them with Read. W9 first checks that Luna accepts images through the engine; if it does not, the images go to the fallback model, or are listed for a person |
| Limits | Files outside the ticket, other types and anything larger are refused; the frames are deleted with the run's folder |

## Out of scope (later)

- Team channel conversations with the bot (posts to channels stay on the webhook).
- The customer chat assistant (Phase 5) and CI/CD (Phase 7).
- Voice messages; Arabic.
- Microsoft sign-in to TBO Support through Teams (single sign-on in the panel).

## How it is built, run and tested

- Built on the Mac like earlier phases: module tests with `hold_commits` on tbo.localhost (the Bot Framework token
  check with our own test keys; the intent reader with a fake AI; every intent's action; cards; reminders and
  snooze; the digest; the panel's API), the worker's unit and end-to-end tests for W9.
- Teams cannot reach tbo.localhost, so the live test is on the **demo hub** after the admin's registration: the
  checkpoint below with two staff accounts.
- The helpdesk part goes into `tbo-copilot` (pushed under the standing instruction); W9 is a pull request into `tbo`.

## Checkpoint (on the demo hub)

1. A fix ready on a demo ticket reaches the approver in Teams; Approve there merges it as on the ticket page; the
   other person's card shows who approved.
2. "What did Copilot change in TASK-…?" is answered from the run, with the PR link; a question about a ticket the
   person cannot read is refused.
3. A change request on a pending fix starts a follow-up fix run after the confirmation.
4. New work with a screenshot raises a ticket for the right demo customer and site; the worker's run shows the image
   in its context; the diagnosis comes back in the chat.
5. A reminder with Snooze, and the next morning's digest, arrive as set.
6. The same from the TBO Support panel; every action is in HDS Copilot Call Log with `via`.

## Risks

- **A bot that can approve.** Mitigation: the same `decide` (head commit, senior rule, first wins), confirmation on
  every action, the person's own permissions, a tenant-only token check, rate limits, everything logged.
- **The model misreads a message.** Mitigation: it only proposes; the person confirms the exact action on a card;
  unclear messages get a question back, never a guess.
- **Prompt injection through a forwarded message or a file.** Mitigation: the model never acts; the Phase 4
  suspicious-text flag also runs on chat messages and attachments' text.
- **The admin's registration takes time.** Mitigation: everything is built and tested on the Mac first; the
  webhook keeps working meanwhile.
- **Cost.** Mitigation: Luna, job `chat` visible in the usage log; a monthly chat limit can join the pilot budget.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| Microsoft 365 admin: a single-tenant app registration and an Azure Bot (messaging endpoint on the demo hub first, then the live hub), its client secret typed into TBO Support by the admin or the owner | H18 | before the live test |
| The admin's approval of the "TBO Copilot" Teams app and a setup policy that installs it for staff | H18, H19 | before the live test |
| Two staff accounts for the live test (an approver and a senior) | checkpoint | before the live test |

## As built (18–19 Oct 2026)

**Helpdesk `tbo-copilot` (pushed):**
- H17 `assistant.py`: HDS Copilot Chat / Chat Message (90 days); intents by `call_haiku(job="chat")`; answers from
  the run's record; proposals with Yes/Cancel (expire after 24 h) for reject, change request, new work; approve and
  reject on the fix card call `approvals.decide` (via Teams/Web); actions as the person; HDS Copilot Call Log kinds
  Teams and Web; 30 messages a minute; the planted-instruction warning on chat messages. New work: the customer from
  the site cards (buttons when several match), the ticket raised for the customer's first contact with
  `flags.skip_acknowledgement` (one line in `hd_ticket.py`), files attached, Copilot started, the diagnosis sent back
  to the chat (`tell_watchers` from the router).
- H18 `teams.py` + `api/copilot_teams.messages`: Bot Framework token (keys from the OpenID metadata, issuer,
  audience, service URL) and tenant checked first; HDS Teams User (email from the conversation's member list);
  messages answered in the background; Adaptive Cards 1.5 with `Action.Execute`; the app package (manifest 1.17,
  personal scope, `supportsFiles`, icons) at `/api/method/helpdesk.api.copilot_teams.app_package`; HDS Copilot
  Settings → Teams bot.
- H19: `approvals.announce` sends the fix card (Teams, else the panel) and skips the webhook for people the bot
  reached; `decide` refreshes every copy of the card; `snoozed_until` holds reminders (not escalation); run news on
  Merged/Resolved/Closed/Escalated/Failed (from `runs._move`); the 09:00 Riyadh digest (hourly check, once a day);
  `chat_notifications.send_direct` goes through the bot when it can reach the person.
- H20: the TBO Copilot panel (sidebar item, `CopilotChatPanel.vue`, `stores/copilotChat.ts`, realtime
  `helpdesk:copilot-chat`) on `api/copilot_chat` (history, send, press).
- For W9: `copilot_worker.ticket_file` and `fix.guidance`.
- Tests: `test_copilot_assistant.py` 26 (engine, Teams token with a real RSA key, activities, cards, endpoint, cards
  reaching people, news, digest), `test_copilot_pilot.py` 21; 28 Copilot and related modules pass (the deploy module
  too, outside its 21:05–24:00 Riyadh flake). Live smoke on tbo.localhost with Luna: help, waiting, a question about
  0102 (answered from the run, right) and new work for the pilot customer all read correctly, about $0.0001 a message.

**W9, a tbo-copilot pull request:** pictures to `context/files/`, videos to `context/frames/` with
ffmpeg (in the image; tested with ffmpeg 7.1, the image has 5.1), `TBO_PROVIDER_*_IMAGES` (OpenAI on), the fix
prompt's guidance. The engine's Read already returns png/jpg/gif/webp as image blocks; the e2e test shows the
picture reaching the model as image data.

**Still open (the checkpoint):** the Microsoft 365 admin's Azure Bot registration and the Teams app setup policy;
then the checkpoint on the demo hub (after its redeploy).
