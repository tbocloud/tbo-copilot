# Phase 13: the customer's support chat, one chat per ticket

Status: plan written 31 Oct 2026, with the owner's four answers (decisions 1–4); **approved and built 31 Oct 2026** ("built phase 13"; decisions 5–7 as recommended): helpdesk_client `tbo-copilot` and helpdesk `tbo-copilot`, **pushed 31 Oct 2026** to `tbo-copilot` (see As built). The checkpoint on the demo bench is next.

**Owner's request (31 Oct 2026), customer side first:** the app on the customer's ERPNext has a support chatbot. It
asks follow-up questions until the issue is clear (module, document, steps, expected vs actual, screenshots), so the
team gets a complete ticket. Not every chat becomes a ticket; those are kept as non-ticket chats, low priority. A chat
that becomes a ticket is shown under the ticket's ID, with the whole conversation. One user can have many tickets, each
with its own chat; inside it they can ask for the status or continue. A ticket closes only when the client confirms it
is resolved; the team cannot close it. Dots: 🟢 the client confirmed (closed), 🔴 waiting for the client (a reply, data,
testing or approval), 🟠 the team is working on it. An **Actions needed** button lists everything the client must do
(the red items). Tabs: **Tickets** (a dropdown to pick the ticket), **New chat** (non-ticket chats), **Action needed**.
A **full page** like the AI Assistant's, with the ticket names as chats and a short summary next to each ID. A new chat
first checks it is a new problem; if it continues a ticket, the user picks that ticket's chat.

**Owner's answers (31 Oct 2026):** (1) a ticket stays open until the client confirms, however long; (2) every ticket
is a chat, also those raised with the old form; (3) a **What's the status?** button answers at once from the ticket;
(4) the round Support button opens the panel, with a red **Actions needed · n** button above it when there is something
to do.

## 1. What the client sees

**The round Support button** opens the support panel. Above it, a red **Actions needed · 2** button shows only while
the user has something to do, and opens the panel on that tab.

**The panel (right side, as today but wider):**

```
┌ TBO Support ─────────────── Tickets │ New chat │ Action needed (2) │ Full page │ × ┐
│ [▾ 🔴 SUP-2026-##### · Invoice won't submit          ]   ← dropdown of the tickets  │
│  🔴 Please confirm the fix works          [What's the status?]                      │
│  …the ticket's chat…                                                               │
│ [ Write your message …                                   ] Attach  Record  Send   │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Tickets:** the dropdown lists the user's tickets, newest activity first, open ones before closed ones. Each row is
  the dot, the ticket ID and a short summary (the ticket's subject, cut to one line). Under it, the selected ticket's
  chat, a status line (dot and what it means) and the **What's the status?** button.
- **New chat:** the current non-ticket chat, and a list of earlier ones (date and first line). **+ New chat** starts
  one.
- **Action needed (n):** only the red tickets, each with what is needed: "Confirm the fix works", "Answer the team's
  question", "Send the data asked for", "Approve the quote". Picking one opens its chat on the Tickets tab.
- **Full page** opens the same on its own page.

**The full page** (`/app/support-chat`, like the AI Assistant's page):

```
┌──────────────────────────────┬──────────────────────────────────────────────────────┐
│ [+ New chat]                 │ 🔴 SUP-2026-##### · Invoice won't submit             │
│ ACTION NEEDED (2)            │ Please confirm the fix works   [It's fixed] [Still…] │
│ 🔴 SUP-…011 Invoice won't…   │                                                      │
│ 🔴 SUP-…014 Stock report …   │   …the chat…                                         │
│ TICKETS                      │                                                      │
│ 🟠 SUP-…015 Print format …   │                                                      │
│ 🟢 SUP-…009 User list col…   │                                                      │
│ CHATS                        │                                                      │
│    How do I cancel an inv…   │ [ Write your message …              ] [What's the    │
│    30 Oct · Payroll quest…   │                                        status?] Send │
└──────────────────────────────┴──────────────────────────────────────────────────────┘
```

Each ticket and chat has its own address (`/app/support-chat/SUP-2026-#####`), so the Actions needed list and the
site's notifications open the right chat.

## 2. The dots

From the site's own Support Ticket, which TBO Support keeps up to date:

| Dot | When | What the status line says |
|---|---|---|
| 🟢 | The client confirmed it is fixed (`customer_confirmation` Confirmed, status Closed) | "Fixed: you confirmed on 31 Oct" |
| 🔴 | Fixed and waiting for the client's check (status Resolved, not confirmed) | "Please check the fix and confirm it works" |
| 🔴 | The team is waiting for the client (status Replied or Paused, or stage Waiting for you) | the team's request, e.g. "Answer the team's question: …" |
| 🔴 | A quote waits for the client's approval | "Approve the quote" |
| 🟠 | Anything else open (Pending, Open; Received, Working on it, Fix scheduled, With our team) | the stage, e.g. "Working on it" |

A non-ticket chat has no dot.

## 3. How it behaves

- **A chat becomes a ticket:** from then on it shows under the ticket's ID and summary, in the Tickets tab. Its record
  keeps its internal name (SUPCONV-…), because TBO Support finds the chat by that name; the user never sees it.
- **New chat checks first:** when the user has open tickets, a new chat starts with "Is this a new problem, or about
  one of these?" and lists them (dot, ID, summary) with **It's a new problem**. Picking a ticket opens its chat; nothing
  goes to TBO Support until they choose.
- **Every ticket is a chat (decision 2):** a ticket raised with the form gets its chat the first time it is opened.
  The form's text is the first message, and the team's earlier updates and replies follow. TBO Support links the
  chat to the ticket, so the user can continue there like any other ticket.
- **What's the status? (decision 3):** answered at once on the site from the ticket: the stage, the latest update,
  who is on it and what is needed from the user. No AI, nobody on the team disturbed. Typed messages still go to the
  team.
- **Only the client closes (decision 1):** the team marks a ticket fixed (Resolved); the client sees 🔴 "Please check
  the fix and confirm" with **It's fixed** and **Still broken**. It stays open until they press **It's fixed**. The
  site reminds the user every 3 days while a fix waits for their check.
- **A closed (green) ticket** is read-only, with **It came back** (reopens it and asks what is wrong) and **New chat**.
- **Notifications:** when a ticket turns red, the user gets a site notification that opens its chat.

## 4. What changes in TBO Support (the hub)

Most of this is on the customer's site. Two parts need the hub:

- **Only the client closes:** on a ticket from a connected site, nobody on the team can set Closed: the ticket
  page explains "Closed when the customer confirms; mark it Resolved". Auto-close skips these tickets. The customer's
  **It's fixed** closes it, as today. Tickets that came by email are not affected (their customer has no app to
  confirm in).
- **A chat for an existing ticket:** the site can ask the hub to open a chat for a ticket raised with the form. The
  hub checks the ticket came from that site and links a conversation to it, in the state **With a person**, with no
  AI.

## Build (about 6 days)

| Code | What |
|---|---|
| C9 | Site API: the user's tickets and chats with dot, summary and needed action (`chat.overview`); open a ticket's chat (creates it for a form ticket); local status answer; the new-chat check; read-only closed chats with **It came back** |
| C10 | The panel: tabs Tickets (dropdown) / New chat / Action needed, status line and **What's the status?**; the shared chat view (messages, attach, record), refactored out of `chat_panel.js` |
| C11 | The full page `support-chat`: sidebar (New chat, Action needed, Tickets, Chats) and the chat; one address per ticket and chat |
| C12 | Launcher: the round button opens the panel; the red **Actions needed · n** button (count in boot, refreshed live when TBO Support updates a ticket); notifications when a ticket turns red; reminders every 3 days for a fix waiting for the check |
| H43 | Hub: only the customer closes a connected-site ticket (status rule, auto-close skips it, the ticket page explains); a chat for an existing ticket (`open_ticket` action) |
| C13/H44 | Tests on both sides, docs (`helpdesk_client` README, `docs/tbo-copilot.md`), a walkthrough in headless Chrome on customer.localhost, the checkpoint on the demo bench |

## Checkpoint

On demo-alpha, signed in as a customer user, with three tickets (one of each colour) and one non-ticket chat:
1. The round button opens the panel. The red **Actions needed · n** button shows the right count and opens that tab.
2. The Tickets dropdown lists the tickets with dots, IDs and summaries. **What's the status?** answers at once.
3. **New chat** asks about the open tickets first. Picking one opens its chat; **It's a new problem** starts a fresh one.
4. A ticket raised with the form opens as a chat, and a message there reaches the team on the demo hub.
5. On the demo hub, an agent cannot close the ticket; they mark it Resolved. On demo-alpha it turns 🔴, and
   **It's fixed** turns it 🟢 and closes it on both sides.
6. The full page shows the same, with each ticket's address working.

## Decisions for the owner

| # | Decision | Answer / recommended |
|---|---|---|
| 1 | The client never confirms | **Answered:** it stays open until they confirm; reminders every 3 days |
| 2 | Form tickets | **Answered:** every ticket is a chat |
| 3 | "What's the status?" | **Answered:** a button, answered at once from the ticket |
| 4 | The round button | **Answered:** opens the panel; red Actions needed button above it |
| 5 | Which tickets only the client may close | Recommended: tickets from a connected customer site; email tickets as today |
| 6 | The full page's address | Recommended: `/app/support-chat` (ERPNext already uses `/app/support`) |
| 7 | A closed ticket's chat | Recommended: read-only, with **It came back** and **New chat** |

## Risks

- **Red after a team reply:** the hub sets Replied after an agent replies, and that turns the ticket red, even when
  the reply was "we're on it". The team sets it back to Open when no answer is needed. Phase 12's chat can say so.
- **Tickets that never close (decision 1):** a client who never answers keeps a ticket open for good. The site's
  reminders help, and the hub's open-ticket counts and SLA reports will include them.
- **Merged tickets:** merging still closes the duplicate on the hub. The site shows it as "Merged into SUP-…" (grey)
  and opens the other ticket's chat.
- **Older hubs:** a hub without `open_ticket` refuses it; the site then shows the form ticket's updates read-only.
- The panel and the full page share one chat view, so both change together.

## As built (31 Oct 2026)

**Customer site (helpdesk_client):**
- **`inbox.py`:**
  - `state` (the dots), `overview`, `ticket_status` (What's the status?), `actions_count`, and `remind_unconfirmed`, run daily.
  - A confirm or reopen counts only until TBO Support moves the status again (`last_synced`), so a ticket fixed a second time asks again.
  - Red means: Resolved or stage Resolved, or Replied, Waiting on Customer, or stage Waiting for you. **Waiting on Task** and **On Hold** stay orange.
  - "Approve the quote" is not shown: no quote reaches the site yet.
- **`chat.py`:**
  - `open_ticket`: a form ticket's chat. Its text and updates come first, then the hub's `open_ticket` links it. It is read-only before TBO Support picks the ticket up, or with an older hub.
  - `history` carries the ticket's dot.
  - In a ticket's chat, It's fixed / Still broken / It came back set the ticket's own confirmation. The hub applies it once, within 5 minutes.
  - A closed ticket's chat takes no messages.
  - `start` never resumes a ticket's chat.
- **Support Ticket:**
  - One notice when it turns red, linked to `/app/support-chat/<ticket>`, in place of the status or stage notice.
  - Live refresh for the panel and the red button.
  - New hidden field `confirmation_reminded_at`.
  - **Open its chat** on the form.
- **JS:**
  - `chat_view.js`: the shared chat view and inbox store.
  - `chat_panel.js`: tabs Tickets (dropdown with 🔴🟠🟢) / New chat / Action needed.
  - `launcher.js`: the round button opens the panel; the red **Actions needed · n** button sits above it and hides while the panel is open. Without the chat, the old form and My Tickets menu stays.
  - Page `support-chat`: the rail and the chat. The floating buttons hide on this page.
- **Tests:** test_inbox 15 new. test_chat 12, stages 11, notifications 4 (the no-poller test now lists the local reminder job), boot 7, hub_api 14, support 12, hub_gate 12, api_security 4 and hub_ping 4 all pass, on customer.localhost.

**Hub (helpdesk):**
- **Only the customer closes:** `HDTicket.check_customer_closes` refuses Closed on a connected-site ticket or one with a Copilot chat, unless one of these closes it:
  - the customer's own action (`flags.closed_by_customer`: their confirmation, their close request, their email feedback);
  - a merge;
  - an earlier **Confirmed**.
  Auto-close skips these tickets.
- **`open_ticket`:** `conversation._ticket_chat`.
- **Tests:** chat 37 and customer 17 (4 new for closing, 3 for `open_ticket`), intake 42, follow-ups 34 and chatwoot 34 all pass.
- **Unrelated failures:** test_hd_ticket's `test_bulk_reply` and the two holiday hold-time tests fail the same without these changes. The first comes from a real file on ticket 0101; the other two depend on the date.

**Walkthrough** in headless Chrome on customer.localhost as copilot.test, with SUP-2026-##### set to Resolved for the run and restored:
- the red button showed "· 1";
- the dropdown showed the dots;
- What's the status? answered at once;
- Action needed opened the ticket;
- New chat asked first;
- the full page showed the rail, a ticket's header with "TBO Support #0102", and a closed ticket with It came back / New chat;
- the phone width had no sideways scroll.

The walkthrough's one new chat was removed on both sites. Console noise came from the theme apps reading Page, and from missing images on the dev site.

**Not done / to know:**
- **Follow-ups:** a connected ticket waiting on the customer was left to auto-close, which now skips it. So the "close the ticket or call the customer" follow-up can name a ticket the team cannot close.
- **Agent replies:** after an agent replies, the hub marks the ticket Replied, which turns it red (risk above).
