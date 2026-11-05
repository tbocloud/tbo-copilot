# Phase 16: the ticket inbox (every ticket as one conversation)

Status: prototype approved and build ordered on 5 Nov 2026 (owner: "yes build"); the decisions below are the
recommended ones. **Built 5 Nov 2026** and **pushed the same day** on the owner's "push": helpdesk `tbo-copilot`. See
As built.

**Owner's request (5 Nov 2026):** "create helpdesk ticket area ui, i am not satisfying, the ui is difficult to catch
easily like our chatbots". Phase 15 made the list and the page cleaner, but a ticket still reads as three tabs (Chat,
Customer, Activity) and a table of rows. The support chat reads at a glance because it is one thread with one box to
write in. This phase brings that shape to the agent's ticket area.

**Prototype:** a private page with its source
(React, mock data). It is the design reference; the build is Vue with frappe-ui, in the agent app's own look and dark
theme.

**Scope:** the agent's ticket list and ticket page in TBO Support (`desk/src/pages/ticket`, `components/ticket-agent`),
desktop and phone. The customer portal, Home, the board and the Copilot panel do not change.

## 1. The layout

```
┌ Tickets ─────────────┬ #0101 Sales invoice won't submit …   [Open ▾] [Rahul ▾] [Details] [⋯] ┬ Details ─────┐
│ [Search …        /]  │ ⚠ Aisha is waiting for a reply, and it's overdue.  [Reply overdue 5m] │ Customer     │
│ (All open 5)(Needs…) │ ✦ Copilot has a fix for your approval: …              [Approve][…]   │ Ticket       │
│ ● AR Aisha · Alpha…  │ (Everything)(Customer sees 3)(Team only 5)                            │ SLA          │
│   Sales invoice …    │  AR ┌ customer, white ┐                       ┌ our reply, blue ┐ LH   │ Their site   │
│   Aisha: Any upd… ①  │     └─────────────────┘                       └─────────────────┘      │ Linked work  │
│   [Overdue 5m][Fix…] │   ┌ ✦ TBO Copilot · only the team (wide grey card) ───────────────┐  │ AI assist    │
│   MK Meera · …       │   └────────────────────────────────────────────────────────────────┘  │              │
│   …                  │          Rahul set the status to Replied · 09:20 (event line)         │              │
│                      │ [Reply to Aisha R] [Note to team C] [Ask Copilot Q]                   │              │
│                      │ [ the editor for that mode ]                                          │              │
└──────────────────────┴───────────────────────────────────────────────────────────────────────┴──────────────┘
```

- **Left, the inbox list** (from 768 px): each ticket as a chat row: the contact's initials, contact · customer, time
  since the last change, the subject (priority arrow for Urgent and High), "Aisha: last message", a number for the
  customer's messages since our last reply, and at most two signals: **Overdue 5m** / **Reply in 20m**, **Fix to
  approve**, **Copilot working**, **Waiting on Aisha**, **Waiting on a task**, **Resolved**, **Unassigned**; the
  assignee's avatar on the right. Not opened yet: bold with a dot.
  - On top: search (`/`), and the Phase 15 queues as chips with counts: All open, Needs reply, Overdue, Mine,
    Unassigned, Waiting, Resolved. A link from Home with its own filters shows them as a **Filtered** chip with Clear.
  - The list stays while you move between tickets (same queue, search and scroll). New tickets and changes refresh it.
- **Middle, the ticket:** the header (Phase 15's, without the Reply button: the box is always there), then:
  - **Where it stands** (two lines, always on top): whose move it is in words ("Aisha is waiting for a reply, and it's
    overdue", "Waiting for Aisha to answer. The SLA clock is paused", "Resolved. Aisha rated it 4/5") with the SLA,
    and Copilot's line (not started / step / its finding / a fix for your approval) with Copilot's buttons (Approve,
    Reject, Start Copilot, Deploy…) and its ⋯ menu. A **Reply to Aisha** button when the customer waits.
  - **One conversation**, oldest first, with day separators: the customer's emails left (white); our replies right
    (blue, "Sent to Aisha"; Copilot's automatic updates marked as such); people's internal notes right (yellow, "only
    the team"); questions to Copilot right (yellow, "To Copilot"); Copilot's messages and cards as wide grey cards
    with their buttons; calls, history and the rating as small centred lines.
    - Filter chips: **Everything**, **Customer sees** (emails and calls), **Team only** (notes and Copilot).
    - A customer email keeps Reply, Reply all and Split ticket; emails render in the existing safe frame
      (`EmailContent.vue`).
  - **One box to write in** with three modes: **Reply to Aisha** (the existing email editor: To, Cc, attachments,
    saved replies, "Use Copilot's draft"), **Note to team** (the existing note editor with @mentions), **Ask Copilot**
    (a chat line with quick questions: Summarise, Draft a reply, Similar tickets, Errors on their site). People who
    may only read the Copilot chat see that instead of the Copilot box.
- **Right, Details:** the Phase 15 panel, unchanged; beside the ticket from 1024 px (hide/show remembered), a sheet below.
- **Phone:** the list full screen; a ticket full screen with a back arrow; status and assignee under the title;
  Details as a sheet. Replaces `MobileTicketAgent.vue`.

## 2. Decisions (built as recommended)

1. **The inbox is the default for Tickets; the Phase 15 table stays one click away** (Inbox | Table switch, remembered
   per browser). Saved views (`?view=`), bulk edit, export and columns live in the table; opening a ticket from the
   table shows the same new ticket page without the list beside it.
2. **No ticket opens by itself** on Tickets: opening one marks it seen, so the middle says "Pick a ticket" until you do.
3. **Copilot as wide grey cards**, never a bubble, so it can't look like a message to the customer.
4. **Our replies are a soft blue bubble**, not solid blue as in the prototype: emails are HTML shown in a frame and
   need a light background to stay readable in both themes.
5. **Keyboard:** R reply and C note stay; **Q asks Copilot** (new); in the list `j` / `k` move and open, `/` searches;
   `[` / `]` stay.
6. **No fixed English quick replies** (the prototype's "Ask for a screenshot"…): the real box offers Copilot's draft
   and the existing saved replies, which the team already maintains.
7. **Old pieces removed once nothing uses them:** `TicketViews.vue`, `TicketActivityPanel.vue`, `CopilotThread.vue`
   (its logic moves to a shared `useCopilotThread`), `MobileTicketAgent.vue`.

## 3. Build steps

| Step | What | Files |
|---|---|---|
| H58 | `ticket_area.inbox(filters, start, page_length)`: the list's rows through the same filters as `count` (so a chip's number is its rows), with each row's last message, the customer's messages since our last reply, and the Copilot signal (a Pending approval: fix to approve; the latest run in a working state: working). `get_communications` marks Copilot's own emails (`by_automation`). Tests | `api/ticket_area.py`, `hd_ticket/api.py`, `tests/test_ticket_area.py` |
| H59 | Routes: `/tickets` becomes a shell with the inbox list and the ticket inside (`TicketsAgent` and `TicketAgent` keep their names and guards); the Inbox / Table switch | `router/index.ts`, `pages/ticket/TicketsInbox.vue`, `components/ticket-inbox/InboxList.vue` |
| H60 | One conversation: emails, notes, calls, history, rating and the Copilot chat merged; bubbles, cards, event lines, filters | `components/ticket-inbox/TicketConversation.vue`, `useCopilotThread.ts` |
| H61 | Where it stands + Copilot's buttons and menu | `components/ticket-inbox/TicketStanding.vue` |
| H62 | The box with three modes | `components/ticket-inbox/TicketComposer.vue` |
| H63 | Phone; header without Reply; shortcuts; old pieces removed | `TicketAgent.vue`, `TicketHeader.vue` |
| H64 | Docs (`docs/ticket-agent-page.md`, `docs/tickets-and-calendar-pages.md`), lint, module tests, walkthrough in headless Chrome on tbo.localhost (desktop, tablet, phone, dark) | |

About 6 days. Pushing waits for the owner's local test and "push" (as always).

## 4. Checkpoint

On tbo.localhost with temporary tickets (deleted after): every queue chip's number equals its rows; a ticket opens in the
middle with the list kept; the thread shows the customer's email, our reply, a note, Copilot's messages and the history
in time order; the three filters; reply, note and Ask Copilot each send and appear in the thread; Approve on a fix
works from the summary; Table switch and back; phone list → ticket → back; dark theme; no console errors.

## As built (5 Nov 2026)

helpdesk `tbo-copilot`, pushed 5 Nov 2026 as a fast-forward (`main` had not moved, so no merge was needed).

- **Server:** `helpdesk.api.ticket_area.inbox(filters, start, page_length)` (agents only; the same filter handling
  as `count`, shared as `_list_filters`); `_conversations` gives each row its newest email, `waiting` and
  `customer_name`, and `last_messages` now uses it (same output). `_copilot_signals`: `approve` for a Pending HDS
  Copilot Approval, `working` for the latest run in a working state. `get_communications` adds `by_automation` and
  the sender's own name for senders without an account; `get_comments` and `get_communications` mark Copilot only
  when an automation user is set up (`_automation_sender`: the Administrator fallback is a person; found on the
  local hub, where every Administrator note showed as Copilot's).
- **Desk:** `pages/ticket/TicketsInbox.vue` (the `/tickets` shell; `TicketsAgent` and `TicketAgent` are its
  children; Table / Inbox in `helpdesk-tickets-layout`), `NoTicketPicked.vue`, `components/ticket-inbox/`
  (`InboxList`, `inbox.ts`, `TicketStanding`, `TicketConversation`, `EmailBubble`, `RichText`, `TicketComposer`,
  `useCopilotThread`), `components/emailReply.ts` (shared with `EmailArea`). `TicketAgent.vue` keys its three parts
  per ticket; `TicketHeader` lost Reply and fits a phone; `TicketTitle` lost the SLA (now in the summary);
  `TicketSidebar` follows its `sheet` prop (a sheet below 1440px beside the list). Removed: `TicketViews`,
  `TicketActivityPanel`, `CopilotThread`, `MobileTicketAgent` and the router's phone switch.
- **Found while building:** the app's route wrapper gives a page root `flex-col` (the shell nests its own row);
  frappe-ui's Button always sets `aria-label` from `label` (icon-only buttons need `label` + the icon slot and
  `tooltip`); `text-ink-white` is not white in this theme (solid chips use `bg-surface-gray-10 text-ink-base`, like
  Button); theme.css's 44px touch rule skips `role=radio`, so the mode pills and filters set it themselves.
- **Tests:** `test_ticket_area` 15 (6 new: a queue's rows are its count, newest email and waiting, Copilot signals,
  pages and agents only, Copilot's emails and notes with and without an automation user, a sender's own name) and
  `test_automation` 8, on tbo.localhost with `hold_commits`; counts before and after equal. Lint: black, isort,
  flake8 strict, prettier 2.6.2.
- **Walkthrough** (headless Chrome, tbo.localhost, 7 temporary tickets with emails, notes, a Copilot chat, a Pending
  approval and a working run, all deleted after, with four empty Copilot chats left from the Phase 15 walkthrough):
  every queue chip equals its rows; search; Home's `?filters=` (queue and Filtered); the list kept while tickets
  change; the summaries of all states; the thread in time order with the three filters; a note added; the reply
  editor and Reply on one email open with the right recipients; Q focuses Ask Copilot; j / k; Table and back; 1440
  (details inline), 1280 (details sheet), 1024 (list + ticket, thread 398px), 800 (one at a time), phone (list →
  ticket, radios 44px), dark; no console errors or failed requests. Not exercised on the live hub on purpose:
  sending a reply (email), asking Copilot (AI call), Start Copilot (a run) and Approve (the real merge path).
- **Not changed:** `ShortcutsModal.vue` holds another session's uncommitted work, so the new Q key is not in the
  shortcuts list yet.
