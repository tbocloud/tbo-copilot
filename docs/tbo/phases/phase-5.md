# Phase 5: the customer support assistant

**Status:** plan written 28 Oct 2026; **approved by the owner 28 Oct 2026 with every recommended decision**; **built 28 Oct 2026, checkpoint passed on the local pair the same day** (see As built). **Estimate:** about 14 developer-days: H26 (the
conversation on the hub, ≈ 6), C8 (the chat panel in the customer's ERP, ≈ 5), H27 (TBO Chat on the same engine, ≈ 2),
and the checkpoint on the local pair (≈ 1). **Design reference:** `expansion-plan.md` Phase 5 (approved 17 Oct, order
6 → 7 → 5; its decisions 2, 3 and 6 are confirmed here). **Built on:** Phase 1a (stages to the customer, Confirm and
Reopen), Phase 4 (Copilot level per customer, monthly budget), Phase 6 (the staff assistant's engine: cards, Yes before
any action, the injection scan), Phase 8 (the written scope, for a customization raised in chat).

## Goal

The Support button in the customer's ERP opens a chat. The assistant asks what a support engineer would ask. With the
customer's permission it records the screen, shows a short summary, and raises the ticket with proper fields instead of
one text box. The chat stays the place to talk: Copilot's progress, its questions, an agent's replies, and Confirm or
Reopen all arrive in it, within seconds. The assistant answers simple questions from the knowledge base. It explains a
cause on the customer's side only after an agent approves the text. It never promises dates or prices, and never changes
data.

## What exists today (checked 28 Oct)

| Found | Consequence |
|---|---|
| The Support button opens one dialog: title, description, an optional screen recording (MediaRecorder, private files, cap 50 MB), screenshots, and a 1–5 minute session replay that is **ticked by default** (`helpdesk_client/public/js/support_ticket.js`, `launcher.js`) | The recorder, uploader and replay are reused in the chat. The replay becomes a question the customer answers, never a default |
| The customer's site makes **two outgoing calls** to the hub: pairing, and a "ticket raised" ping with no data. Its tests enforce that | A chat needs a third call: the customer's message, signed (decision 1) |
| The hub **pulls**: new tickets every minute; customer comments, agent replies and closings **every 5 minutes**, as internal comments (`ticket_puller.py`) | Too slow for a chat. Messages go both ways at once (H26, C8), and the pull stays for older sites |
| The page, document, roles, recent errors and app versions are captured when the dialog opens, **but the hub's import reads none of them** | The chat ticket carries them, and the triage and the worker get them |
| Stage messages reach the site through `hub_api.add_update`, kinds Stage/Reply/System. Confirm and Reopen exist on the ticket form (`confirm_resolution`, `reopen`) | The chat shows the same updates and the same two buttons |
| TBO Chat (Chatwoot) has a bot: one model call per message, with JSON `answer`/`ticket`/`human`, up to 3 knowledge base articles by keyword, and article links only (`chatwoot_bridge.py`). It uses job `triage`, logs no ticket, and is outside every budget | The same engine serves it in H27 |
| Knowledge base search for AI: keyword `LIKE` on Published articles, **English words only** (the regex drops Arabic letters), top 3, score ≥ 2 (`ai_suggestion.find_related_articles`). Published articles are public on the portal already | Answers quote only those articles. Arabic needs its own keyword handling (decision 6) |
| The staff assistant (`copilot/assistant.py`): channel-neutral cards, Yes/Cancel proposals that expire, the injection scan, a rate limit, a call log. It is for agents only, keyed to a Frappe user, with staff intents | The patterns are reused. The customer mode has its own doctypes, intents and limits |
| `call_haiku(system, user, ticket_name, job)`: one turn, JSON, failover between providers, a usage log. **No budget check**; the monthly Copilot budget counts only run costs | The conversation logs its cost, and is capped per conversation and counted in the monthly budget (decision 7) |
| Explanations of a customer-side cause are drafts an agent sends from the suggested-reply card; nothing is sent by itself | Unchanged in the pilot: the approved text goes into the chat (decision 2) |

## Decisions in this plan (please confirm)

| # | Topic | This plan (recommended) | Why |
|---|---|---|---|
| 1 | **How messages travel** | The customer's site **relays** each message to a new hub endpoint, server to server, **signed with a key derived from the pairing key** both sites already share. The hub answers in the same call (a few seconds; a "typing" dot meanwhile). Messages the hub starts (stages, questions, agent replies) reach the site at once through a new `hub_api.post_message`, and the panel shows them live (Frappe realtime). Older sites keep today's form and pull | The browser never talks to the hub (no cross-site calls, no hub login for customers); the customer's own site vouches for who is writing, as it does for tickets today; no re-pairing is needed. The alternative, the browser calling the hub with a short token, needs cross-site access on the hub and polling |
| 2 | **What the assistant may say on its own** (expansion decision 2) | **Itself:** greeting, questions, the recording request, the summary, stage updates. **Itself, only with a source:** an answer from a Published knowledge base article that clearly matches, quoting its link; otherwise it offers to raise a ticket. **After an agent's one click:** explanations of a cause on the customer's side (today's suggested-reply card; the approved text goes into the chat). **Never:** dates, prices, quotes, data changes, anything legal | Intake and status are safe; a sourced answer can be checked; an explanation can blame wrongly, so a person reads it during the pilot. Later, per category, after N approvals with no edit |
| 3 | **Channels** (expansion decision 3) | **The ERP chat first (H26, C8), then TBO Chat (Chatwoot) on the same engine (H27)**, so both behave the same; Chatwoot keeps today's bot until H27 | One engine, two thin adapters. The ERP chat is where the pilot customers are |
| 4 | **How the assistant works** | Like the staff assistant: **the model reads and writes text, the code acts.** Each turn the model fills the ticket's fields from the customer's words and drafts the next message, of a fixed kind (question, recording request, summary, knowledge base answer, hand-over). Nothing is raised until the customer presses **Raise the ticket** on the summary | Predictable: no tool loop, every action is a button, and every answer has a source or is a question |
| 5 | **Recording and replay** | The assistant **asks**; it says exactly what is recorded and who sees it; the browser's own prompt follows; files stay private to the ticket. The session replay becomes the same kind of question (never ticked by default). Screenshots and files are accepted at any time. The recording cap follows the site's own upload limit | Consent the customer gave, in words they read; today's default-on replay is the wrong default for a chat |
| 6 | **Languages** (expansion decision 6) | The assistant **replies in the customer's language, English or Arabic**, from the start. The stage messages get Arabic texts (settings rows per language). Knowledge base matching in Arabic comes when Arabic articles exist; until then an Arabic question gets the offer to raise a ticket | Phase 6 promised Arabic with this phase; the model writes Arabic well; answers stay sourced |
| 7 | **Limits and cost** | Per customer: 10 messages a minute and 200 a day. Per conversation: at most $0.25 of AI and 40 turns, then a hand-over to a person. The chat's AI cost counts in the **monthly AI budget**; over it, the chat still raises tickets but stops answering questions | A customer chat is open to the public of each site; the budget must cover it |
| 8 | **"Talk to a person"** | Always there. It raises the ticket (or uses the open one) with the whole transcript, and says the team will answer **in the chat**; agents' replies reach it within seconds | The customer never feels stuck with a bot |

## What you will see at the end

1. A user on a customer's ERP site presses **Support**. A chat opens: "Hi Ali, I see you are on Sales Invoice
   SINV-0042. What happened?" A small link reads **Send a form instead**.
2. The customer writes "it won't submit, says margin error". The assistant asks what a support engineer would ask, one
   question at a time: what they expected, whether other invoices fail too, and since when.
3. "May I record your screen while you try again? I'll record this browser tab only. Only TBO's support team will see
   it, and it is attached privately to your ticket." The customer presses **Record** and the browser asks. The customer
   reproduces the error and presses **Stop**.
4. A summary card shows the title, the steps, expected and actual, the record, since when, and the recording, with
   **Raise the ticket** and **Change something**. The customer presses **Raise the ticket**. The chat shows "Ticket
   #0101 is raised".
5. The hub ticket has the structured description, the context (page, document, roles, recent errors), the recording,
   and the transcript. Triage and Copilot start as today.
6. In the chat, minutes later: "We found what is happening and are working on it." Later: "A fix is ready and will go
   live on Thursday." Then: "Resolved. … Please confirm this solved it", with **It's fixed** and **Still broken**.
7. A question such as "how do I cancel a submitted invoice?" gets an answer from the matching article, with its link,
   and "Did this answer it?". **No** offers to raise a ticket.
8. When Copilot finds the customer's own mistake, an agent approves the explanation on the hub and the text appears in
   the chat. An agent's ordinary reply appears there too.
9. An Arabic question gets an Arabic reply.

## What changes, part by part

### H26 (helpdesk): the conversation on the hub (≈ 6 days)

- **Doctypes:**
  - **HDS Conversation**: connection, customer, the site's user (email and name, as the site vouches), channel (ERP or
    TBO Chat), state (Talking, Summary, Ticket raised, With a person, Closed), the ticket, the draft fields (title,
    steps, expected, actual, records, since, scope, worked before), language, turns, cost.
  - **HDS Conversation Message**: direction (customer, assistant, agent, system), kind (text, question, summary, answer,
    stage, recording request, hand-over), text, card, files, its source articles, cost, and the hub reference used to
    deliver it.
  - Agent Managers and System Managers can read them. The ticket links its conversation, and the agent sees the
    transcript on the ticket.
- **`copilot/conversation.py`, the engine (customer mode):**
  - Each turn makes one `call_haiku(job="chat")` with:
    - the conversation's fields and its last 12 messages;
    - the page context;
    - the customer's message, wrapped as data;
    - the matching Published articles.
  - The model returns JSON: `{"fields": {...}, "next": question | record | summary | answer | handover, "text",
    "sources", "language"}`.
  - The code checks the answer:
    - an `answer` must cite an article it was given, or it becomes the offer to raise a ticket;
    - links are kept only to those articles;
    - nothing is promised about dates or prices (a fixed check on the text, plus the prompt);
    - the injection scan runs on every customer message.
  - Buttons are the code's own: **Raise the ticket**, **Change something**, **Record**, **Talk to a person**, **It's
    fixed**, **Still broken**.
- **Raising the ticket** (as today's import does, without the 1-minute wait):
  - It makes an HD Ticket with `via_customer_portal` and the connection.
  - The description is laid out with the structured fields.
  - The context fields from the site are read at last: page, document, roles, recent errors, app versions.
  - The recording and screenshots are fetched with the existing authenticated download, and triage gets them.
  - The site's Support Ticket is made by the hub with `hub_api` (it already accepts its fields). That keeps one ticket on
    each side, linked.
- **The signed endpoint** `helpdesk.api.copilot_conversation.message`:
  - Guest, POST.
  - The body says the connection, the site user, the conversation, the text and the file links. It carries a timestamp
    and an HMAC-SHA256 under a key derived from the connection's pairing key (`HMAC(approval_key, "conversation-v1")`).
  - A 5-minute window and a nonce refuse replays.
  - It refuses anything a paired, active connection did not sign.
  - It answers with the assistant's messages.
- **Toward the chat:**
  - `customer.send_stage`, approved explanations (`on_agent_reply`) and agents' replies (Sent Communications) on a
    ticket with a conversation go to the site at once with `hub_api.post_message`, instead of waiting for the 5-minute
    sync.
  - The customer's chat messages become **Received Communications** on the ticket, not internal comments. So a Copilot
    run waiting for an answer gets it as it does from email.
- **Limits:**
  - Per-customer rates (Redis, as the staff assistant).
  - The per-conversation cap and the monthly budget: `pilot.month_spend` adds conversation costs.
  - Over a limit, the next message hands over.
- **Settings** (HDS Copilot Settings → Customer chat):
  - enabled (off by default);
  - the limits;
  - the opening text;
  - the recording consent text (English and Arabic);
  - the stage texts in Arabic.
- **Tests: `test_copilot_conversation.py`, about 25:**
  - a signature from another connection, an old timestamp or a replayed nonce is refused;
  - fields fill over turns;
  - a summary raises the ticket only after the button;
  - an answer without a source becomes the offer;
  - links outside the given articles are removed;
  - a date or price promise is removed;
  - injection text is treated as data;
  - the limits hand over;
  - stages and agent replies are pushed;
  - Confirm and Reopen;
  - Arabic in gives Arabic out.

### C8 (helpdesk_client): the chat panel (≈ 5 days)

- **The panel:**
  - **Support** opens a chat panel (plain JS like the rest of the app; no new framework) instead of the dialog.
  - **Send a form instead** keeps today's dialog.
  - The panel shows messages, a typing dot, buttons, files, the recording button with its pill and timer (today's
    recorder), screenshots, and Confirm and Reopen.
  - **My Tickets** lists conversations too.
- **The relay** `helpdesk_client.chat.send` (logged-in user, POST):
  - It signs the request and posts it to the hub (the third outgoing call; the tests that enforce two are updated to
    allow exactly this one).
  - It keeps the reply in a local **Support Conversation** with its messages.
  - Files are uploaded privately on the site first, then passed as links the hub downloads, as today.
- **From the hub:** `hub_api.post_message` (support user, POST, idempotent on its reference). It writes the message,
  sends `frappe.publish_realtime` to that user, and adds a Notification Log when the panel is closed.
- **The context** is captured at the first message, as the dialog does today. It is sent with the first message only.
- **The other pieces:**
  - The capability `chat_v1`, so the hub knows the site can chat.
  - The recording cap follows `frappe.boot.max_file_size` (today's 50 MB fallback is above Frappe's 25 MB upload limit).
  - The replay never starts ticked.
- **Tests:**
  - the relay signs, and refuses when the site is unpaired or the feature is off;
  - `post_message` is support-user only, POST only, and idempotent;
  - a customer sees only their own conversations;
  - files are private;
  - the outgoing-call test allows the relay only.

### H27 (helpdesk): TBO Chat on the same engine (≈ 2 days)

- The Chatwoot bot's first reply goes through `conversation.py` (channel TBO Chat).
- The visitor is matched to a Contact as today.
- The conversation keeps its fields.
- **Raise the ticket** and **Talk to a person** hand over as today.
- Copilot's stages now reach a Chatwoot chat too.
- Its AI cost counts in the budget (job `chat`, with the ticket).
- The existing Chatwoot tests keep passing, and new ones cover the shared engine.

## Out of scope (later)

- Explanations sent without an agent, per category, once proven (decision 2's "later").
- Arabic knowledge base matching, until Arabic articles exist.
- Voice notes.
- Proactive messages (Copilot noticing errors before the customer writes).
- WhatsApp through Chatwoot (H27 makes it a configuration step, not code).
- The ERP AI assistant (`erp_ai_assistant`) stays separate (expansion decision 7); a later link could hand "raise a
  ticket" to this chat.

## How it is built, run and tested

As in the earlier phases:

- helpdesk and helpdesk_client on their `tbo-copilot` branches;
- module tests on the local sites with `hold_commits`, one module at a time;
- the checkpoint on the local pair (customer.localhost ↔ `tbo.localhost`) before anything is pushed;
- no worker change.

## Checkpoint (on the local pair)

- **The main path:** on customer.localhost:
  1. The chat opens with the page context.
  2. A bug is described over a few questions.
  3. The recording is asked for, given and attached.
  4. The summary raises ticket N on tbo.localhost with structured fields, context, the recording and the transcript.
  5. A Copilot stage appears in the chat within seconds.
  6. An agent's reply appears in the chat.
  7. **It's fixed** closes the ticket.
- **Answers:** a question with a matching article gets a cited answer; one without gets the offer to raise a ticket.
- **Refusals and limits:**
  - a message signed with another site's key, an old one, or a replay is refused;
  - an injection attempt is treated as data;
  - a customer over the per-minute limit, or a conversation over its cap, is handed to a person;
  - with the feature off, the form appears as today.
- **Arabic:** an Arabic message gets an Arabic reply and the Arabic stage texts.
- **TBO Chat:** a Chatwoot conversation runs through the same engine and gets a stage message.

## Risks

| Risk | Mitigation |
|---|---|
| The assistant says something wrong to a customer | Answers only from cited Published articles; explanations of the customer's own mistakes only after an agent's click; no dates, prices or data changes; every conversation is on the ticket for review |
| Prompt injection through the chat | The customer's text is data in the prompt; the injection scan flags it; the model cannot act, only the customer's and agents' buttons do |
| AI cost from a public-facing chat | Per-customer rates, a per-conversation cap, the monthly budget; over a limit it hands over instead of answering |
| A forged message to the hub | Signed per connection, with a time window and a nonce; only paired, active connections; the site vouches only for its own logged-in users |
| The hub is down or slow | The panel says so and offers **Send a form instead**, which uses today's pull |
| Older customer sites | They keep today's form and pull until they update helpdesk_client (`chat_v1` decides) |
| Privacy of recordings and replays | Asked for in plain words, never by default; private files; the 30-day replay cleanup stays |

## What TBO must provide

- The decisions above.
- Knowledge base articles worth quoting, Published (they are public on the portal already), and Arabic ones when
  Arabic answers should come from the knowledge base.
- The pilot customer's site updated to the new helpdesk_client (the chat needs it).
- Nothing new from Microsoft, AWS or GitHub.

## As built (28 Oct 2026)

**Pushed:**
- helpdesk `tbo-copilot`: H26, H27, the checkpoint's fixes, and main merged in.
- helpdesk_client `tbo-copilot`: C8, and main merged in.

**Tests:**
- `test_copilot_conversation.py`: 24.
- `test_chatwoot_bridge.py`: 34, 3 of them new.
- The client's `test_chat.py`: 10.
- Every Copilot module the change touches, and the client's intake, hub_api and ticket modules, pass.

**How it differs from the plan, and why:**

- **Re-pairing, once, for sites paired before Phase 3.** A site paired before the pairing key existed has no key. Its chat is refused until someone presses **Connect to TBO Support** on the site once more; Phase 3's corrections need the same key. Sites paired since Phase 3 need nothing. The local pair needed this (both sides were given the same new key).
- **The language** is decided by the letters the customer writes; the model's report counts only when there are none. The model once reported English for an Arabic chat.
- **Sources** may be an article's name or its title, since the model cites titles.
- **The recording** is asked for at most once, and never again once a recording is attached.
- **TBO Chat's bot keeps its own Chatwoot view of the chat** (who wrote, their open tickets, the articles, the transcript) as the data for the shared engine. A summary there raises the ticket at once, because Chatwoot has no buttons. The old chat prompt's writing rules (acknowledge first, check back, never invent causes) moved into the shared prompt.
- **The site keeps its own Support Ticket** for a chat's ticket, created Open with the hub's number. The ticket pull therefore never imports it twice, and the "new ticket" ping is skipped.

**Checkpoint (local pair, 28 Oct, the real model):**
- **Main path:** a user of the pilot customer on Sales Invoice ACC-SINV-2026-00042.
  1. The greeting named the record.
  2. The assistant asked three questions.
  3. It asked once to record; the recording was attached.
  4. The summary raised ticket 0102. The ticket had the structured fields, the page, record and roles from the site, and the transcript; the recording was fetched from the site's ticket.
  5. A stage, an agent's reply and the Resolved stage (with **It's fixed** and **Still broken**) reached the chat.
  6. **It's fixed** closed 0102 as Confirmed.
- **Answers:** a question the new article answers got a cited answer with its link. One without an article got a clarifying question.
- **Arabic:** Arabic replies, an Arabic ticket message and hand-over (0103), and the Arabic stage text.
- **Refusals:**
  - a replayed request, another key, an hour-old timestamp, a body changed after signing, and an unpaired connection were each refused with 403;
  - an injection attempt was answered safely and flagged;
  - the per-minute limit handed over to a person (0104);
  - with the chat off on the hub, the site offered the form.
- **What the checkpoint found and fixed:** the recording loop, sources by title, the language of an Arabic hand-over, and the model echoing its instructions.
- **The local environment:** the dev server and workers, running since 12 Oct with closed outputs, failed every request that printed. They were restarted with log files.
- **Not covered on the local pair:**
  - the live update in the browser, since there is no socket server locally (messages arrive on reopening the panel);
  - TBO Chat, since there is no local Chatwoot. It is covered by `test_chatwoot_bridge.py`.

