# Phase 15: a cleaner ticket area in TBO Support

Status: plan written 4 Nov 2026; **approved 4 Nov 2026** ("approve", all eight decisions as recommended); **built 4 Nov 2026**: helpdesk `tbo-copilot`, with main merged, **pushed 4 Nov 2026** on the owner's "push". See As built.

**Owner's request (4 Nov 2026):** "similarly plan a better ui in helpdesk ticket area only", the same way as the support
chat: a prototype first, then the real build. **Ticket area only:** the agent's ticket list and ticket page in TBO
Support (`desk/src/pages/ticket`, `components/ticket-agent`), on desktop and phone. Nothing else in the agent app changes.

**Prototype:** a private page with its source
(React, mock data). **Preview states** in its left rail shows each state. It is a design
reference: the real build stays Vue with frappe-ui, in the agent app's own look and dark theme.

**What stays from Phase 12** (the owner's "no removing the things, neatly arranged"): every action and field is kept;
a ticket opens on **Chat**; tabs Chat / Customer / Activity; who may write in the chat; the ⋯ menu's three groups;
Details in folding sections.

## 0. What is wrong today

Seen on tbo.localhost on 4 Nov with six temporary tickets (deleted afterwards):

**The list**
- Five count cards fill a whole row above the list; the queues they stand for are not tabs, and two common ones
  ("needs a reply", "mine") are missing.
- The filter row is four separate boxes (ID, Subject, Estimate Status, Customer); there is no single search.
- A row shows the subject but not who wrote last or what they said, so you open tickets to find out.
- Two SLA columns per row (First response, Resolution) show two times; only one is due next.
- Colours mix meanings: **Open** has a red dot, the same red as an overdue SLA.
- For the Administrator, the **Getting started** panel opens over the list and the ticket page.

**The ticket page**
- The same facts appear two or three times:
  - the number: in the breadcrumb and again as a chip;
  - the status: in the header picker and again as a chip;
  - the assignee: in the header ("Agent agent", the name twice), in "Assigned to agent" under the title, and in Details;
  - the priority: as a chip and in Details.
- The Chat tab says **Needs you** when Copilot simply hasn't started.
- On the Customer tab, the reply box is two small buttons at the bottom left, while **Reply** is also in the header.
- An open ticket shows an empty five-star rating box.
- Activity repeats the full email cards from the Customer tab.
- Details shows placeholders like "Select type" and "Not set".
- On a phone, the breadcrumb cuts the title ("Ticke / Sales invoice won't subr"), and the status picker takes the
  first line.

## 1. Rules for the whole ticket area

- **Each fact once.** The header has the status, the assignee and the actions. The line under the title has the
  contact, customer, channel, age, priority and SLA. Details has the rest.
- **Red only means late** (an SLA overdue) or **Urgent** priority. A status shows whose move it is with an **icon and a
  word**: Open (the team's move), Replied and Waiting on Task (waiting on others), On Hold, Resolved, Closed.
- **The SLA in words:** "Reply in 20m", "Reply overdue by 5m", "Resolve by Fri 16:00", "SLA paused: waiting". It always
  shows what is due next, not two times.
- **Keyboard:**
  - on the list: `j` / `k` move, `Enter` opens, `/` searches;
  - on a ticket: `R` replies, `C` adds a note (both exist today), `[` / `]` go to the previous / next ticket.
- Controls at least 40 px; works in the agent app's light and dark themes; phone width without sideways scroll.

## 2. The list

- **Queues as tabs with counts**, replacing the five cards:
  - **Needs reply:** Open, and the customer wrote last;
  - **Overdue:** past the first reply or resolution time; its count shows in red when there are any;
  - **Unassigned**;
  - **Mine**;
  - **Waiting:** Replied, Waiting on Task or On Hold, so the SLA is paused;
  - **All open**;
  - **Resolved**.

  Each count uses the same filters as its tab, as the cards do now (`ticketFilters.ts`). Saved views stay in the
  **List ▾** menu.
- **One search** over number, subject, customer and contact; three filters, **Customer**, **Priority** and
  **Assignee** (with Unassigned); **Clear filters**. Filter, sort and **Columns** stay.
- **A row:**
  - a dot for a new customer message;
  - the number and subject, with a second line of who wrote last and their first words ("Aisha: Any update?
    Finance needs…") and when;
  - customer, status chip, priority, one **Due** column, and the assignee with initials.

  The First response and Resolution columns can still be added under **Columns**.
- **Selecting tickets** shows a bar with Assign (people on leave not offered), Set status, Set priority and Clear.
- **States:** loading rows, an empty queue that says what the queue holds, and "no tickets match these filters".
- **Phone:** one card per ticket, with the same facts.

## 3. The ticket page

- **Header, one line:**
  - ← Tickets, the number, previous / next;
  - on the right: the **status** picker, the **assignee** picker ("on leave until 7 Nov" shown and not offered), **Reply**,
    ⋯, and a button to show or hide Details.
- **Under the title, once:** contact (initials), customer, "via Customer site · opened 3h ago", priority, SLA.
- **Chat tab** (opens first):
  - **A Copilot line**, with four states:
    - "Copilot hasn't looked at this ticket yet" with **Start Copilot**;
    - "working on it: step 2 of 4", with the steps;
    - **"a fix is ready: it needs an approval"** with **Review the fix**, the only state with the amber "needs you"
      look, also shown as a dot on the Chat tab;
    - "Copilot found: …".
  - "In this chat: Copilot · Rahul (assigned) · Fatima (coordinator) · Admins".
  - The customer's request card first, then Copilot (spark avatar) and the people (initials), with time lines in
    between ("Assigned to Rahul: the customer's developer").
  - The proposed fix as a card: what changed, the files, **Approve**, **Reject**, **See the changes**.
  - The message box; for someone who may only read, a line saying who can write.
- **Customer tab:**
  - Filters: All / Emails / Internal notes / Copilot updates, with counts.
  - Each message is a card by kind:
    - the customer's email;
    - the team's reply (tinted);
    - an internal note (yellow, "only the team sees it");
    - a Copilot update ("Sent by Copilot").
  - The writing box is pinned at the bottom with **Reply to customer | Internal note**, To:, templates or mentions,
    attach, and **Send** (Ctrl + Enter).
  - **Copilot's drafted reply is offered inside the box** ("Use the draft"), not in a card elsewhere.
  - A line under the box says a reply sets the status to Replied and pauses the SLA.
  - The customer's rating shows only on a resolved or closed ticket.
- **Activity tab:** one line per event (created, assigned, status, priority, SLA, Copilot, views grouped into one
  line). Messages stay on the Customer tab.
- **Details**, in this order, each folded with a one-line summary (Ticket open):
  - Ticket: priority, type ("Add a type"), team, assigned to, customer owner;
  - Customer and contact;
  - SLA;
  - Customer site: page, record, roles, recent errors, Login to site, Recordings;
  - Linked work;
  - AI help: triage, duplicate, similar tickets;
  - Recent tickets from this customer.
- **Phone:** the header wraps cleanly, the status and assignee pickers sit side by side, and the tabs are Chat,
  Customer, Activity and Details.

## 4. How it is built (helpdesk `desk/`)

- **The list:**
  - `Tickets.vue` and its cells (`slaCell`, `priorityCell`, the status cell, `#mobile-row`);
  - `TicketSummaryStrip.vue` becomes the queue tabs;
  - `ticketFilters.ts` gains Needs reply, Mine, Waiting and Resolved.

  The shared `ListViewBuilder` (also used by Call logs and the knowledge base) gets only optional slots, so the
  other lists don't change.
- **The preview line** comes from one call for the rows on screen: each ticket's last customer-facing message,
  sender and time. "Who wrote last" comes from `last_customer_response` and `last_agent_response`.
- **The ticket page:** `TicketHeader.vue`, `TicketTitle.vue`, `TicketViews.vue`, `CopilotThread.vue`,
  `TicketAgentActivities.vue`, the reply editor (`TicketTextEditor.vue`, `AiSuggestedReplyCard.vue` moves into it),
  `TicketSidebar.vue` / `PanelSection.vue`, and `MobileTicketAgent.vue` for phones.
- **Status colours** come from **HD Ticket Status** (each status has a colour an admin can change). A patch sets the
  defaults to match the rule (Open blue, Replied and Waiting on Task amber, On Hold gray, Resolved green, Closed
  gray), only for statuses still on their install colour (decision 4).
- **No server change** except the preview call; permissions, assignment and Copilot stay as they are.

| Code | What | Days |
|---|---|---|
| H49 | Queue tabs and counts; one search and the three filters; Clear filters | 1 |
| H50 | List rows: preview line (new call), one Due column, status chip, assignee; selection bar; empty and loading states; phone cards; `j` / `k` / `/` | 2 |
| H51 | Ticket header and the line under the title, each fact once; previous / next with `[` / `]` | 1 |
| H52 | Chat tab: the Copilot line's four states, the fix card, avatars and time lines | 1 |
| H53 | Customer tab: message cards by kind, filters, the pinned writing box with Reply / Internal note and Copilot's draft; rating only when resolved | 1½ |
| H54 | Activity as one line per event; Details order, summaries and "Add …" placeholders; the leave hint in pickers | 1 |
| H55 | Status colour patch; Getting started not opening over the ticket area; dark theme check | ½ |
| H56 | Phone ticket page (`MobileTicketAgent.vue`) | 1 |
| H57 | Tests (filters and counts, the preview call), docs, a walkthrough in headless Chrome on tbo.localhost (desktop, phone, dark, an agent and a reader), the checkpoint on the demo bench | 1 |

**About 10 days.**

## Checkpoint

On the demo hub, as an agent with tickets in each state:
1. The queues show the right counts. Needs reply holds only open tickets where the customer wrote last, and its count
   matches its rows.
2. A row's second line shows the last message. The Due column says "Reply in …" or "overdue by …"; red appears only
   for overdue or Urgent.
3. On a ticket, the number, status, assignee and priority each appear once. Every action from today is still in the
   header, ⋯ or Details.
4. Chat opens first. "Needs you" appears only when a fix waits for approval.
5. Reply opens the pinned box on the Customer tab with Copilot's draft offered. Sending sets Replied and pauses the SLA.
6. The phone page has no sideways scroll; the dark theme reads well.

## Decisions for the owner

| # | Decision | Recommended |
|---|---|---|
| 1 | The five count cards | **Replace them with queue tabs** (same filters, same counts, plus Needs reply, Mine, Waiting, Resolved) |
| 2 | The row | **Add the last message line**; one **Due** column instead of First response + Resolution (both stay under Columns) |
| 3 | The colour rule | **Red only for overdue and Urgent**; statuses with an icon and a word |
| 4 | Status colours | **A patch sets the defaults** (Open blue, …), only where an admin has not changed them |
| 5 | Copilot's drafted reply | **Inside the writing box** ("Use the draft"); the separate card goes |
| 6 | Activity | **One line per event**; emails and notes only on the Customer tab |
| 7 | Getting started | **Not opening over the ticket list and ticket pages**; still reachable from Help |
| 8 | Customer rating | **Only on resolved or closed tickets** |

## Risks

- **Saved views and chosen columns** must keep working. The queues are tabs over the same list, and **Columns** keeps
  every column.
- **The preview call** adds one small query per page of rows (20 by default). It reads only the newest message of
  each ticket on screen.
- **Admins who changed status colours** keep their colours (decision 4). The icons and words still say what each
  status means.
- **The shared list builder:** only optional slots are added, so Call logs and the knowledge base look the same.
- **The phone page is a separate file** (`MobileTicketAgent.vue`), so it is built and checked on its own.

## As built (4 Nov 2026)

helpdesk `tbo-copilot`; main merged (conflicts: patches.txt and hooks.py both sides; `ai_engine.complete` / `call_haiku` take `job`, `fallback` and main's `images`, every caller by keyword; two layout files' imports), **pushed 4 Nov 2026**. After the merge: test_ai_engine 33, ai_jobs 12, lead_bank 19, ticket_area 9, copilot_conversation 44, exact_assignment 5, ticket_intake 42 pass; the exact commit builds in a clean checkout.

**The list**
- Queues replace the five tiles (`TicketSummaryStrip.vue`): Needs reply (status category Open), Overdue, Unassigned,
  Mine, Waiting (Paused), All open, Resolved, and **All**.
  - All is the view's own list and **shows no number**: a personal default view can filter it, so a count could
    disagree with its rows (seen on tbo.localhost).
  - The counts use `helpdesk.api.ticket_area.count` through `get_list`. The old tiles' `frappe.client.get_count` calls
    `frappe.db.count` and **ignored permissions**, contrary to the old comment.
- `__overdue` and `__search` are resolved on the server into name lists of at most 1,000 (`api/ticket_area.py`,
  hooked into `get_list_data`).
- The agent quick filters are Search, Customer, Priority and Assigned to (`_assign =` now accepted, matched through
  ToDos). The portal keeps its own.
- Two-line rows (`ListViewBuilder` gets an optional `rowHeight`, 56): the subject, then the newest email
  (`last_messages`, quoted mail cut off).
- One **Due** column (`dueBadge`). It keeps the existing rule that a running deadline is shown as a time, because
  SLAs run on working hours. "Reply in N working min" appears only in the last working hour, and "overdue by" counts
  clock time. A saved view that still has both clocks keeps its two cells.
- Status chips use `statusBadge` with an icon per status. The selection bar gains Assign, Set status and Set priority
  (`BulkEditDialog.vue`). `j` / `k` / `/` use the app's `useShortcut`.

**The ticket page**
- The title line shows each fact once. **Copy ticket ID** moved into the ⋯ menu.
- The status picker and menu show icons. **Details** toggles at every width (kept per browser). `[` / `]` move between
  tickets.
- **Bug fixed:** the assignee's name showed twice ("Agent agent").
- The Copilot line has four looks, and "Needs you" only for a decision verb, not `start`.
- Internal notes; Copilot's ready draft is offered in the reply box. **Different from the plan:** the AI card stays
  in Details → AI assist, so that Draft again with instructions and its sources stay, keeping Phase 12's "nothing
  removed".
- Activity shows one line per email, internal note and call, opening the Customer tab. Copilot's own notes keep their
  card, as they are not on the Customer tab.
- The rating shows only when resolved or closed with a rating. On the 3 Nov screenshots, the empty stars came from
  the temporary tickets having no rating at all (a real ticket stores 0).
- Details: the first section is "Ticket", the customer site follows the SLA, the wording is "Add a type", and the SLA
  summary uses the Due words.
- The phone page's breadcrumb is "#number", with the subject in full and the same line under it.
- Getting started no longer opens over TicketsAgent / TicketAgent.

**Server**
- Patch `ticket_area_status_colours`. New installs start with Open Blue, Replied Amber, Waiting on Task Amber.
- Default columns: Due in place of First response and Resolution.

**Tests:** `test_ticket_area` 9 (new): every queue's count against its own list, Mine, the exact assignee, the
search, the quick filters, the last message with quotes cut, long messages, the patch, the default columns.
`test_exact_assignment` 5 and `test_hd_ticket_status` 3 also pass. The front end builds with vite (needs
`NODE_OPTIONS=--max-old-space-size=8192`; the default heap ran out).

**Walkthrough** in headless Chrome on tbo.localhost as Administrator, with 7 temporary tickets written straight to
the database (no hooks), with the fields a save computes:
- the queue counts matched their rows (4 / 3 / 2 / 1 / 2 / 6 / 1);
- the search, `j` / `k` / `/`, the selection bar and its Assign dialog;
- the title line and Details hide or show;
- the Copilot line on a ticket Copilot hasn't looked at, without "Needs you";
- Internal notes, the Activity lines and a line opening its message;
- `]`, dark mode, and the phone list and ticket without sideways scroll;
- no console errors or failed requests.

It found and fixed: two-value labels ("Reply,6m overdue by {1}": the app's `__` takes separate arguments), All's
count, and the Details SLA summary's old wording. All the temporary data was removed; the support site is back to
its counts.

**To know**
- The local bench (web, Redis) was stopped when this session began. I started Redis and the web server for the tests
  and walkthrough, and stopped them after.
- **tbo.localhost again has no tickets.** Ticket 0101 seen on 4 Nov morning was gone by the afternoon, before this
  session's runs.
- **Uncommitted work by another session** sits in helpdesk (`CopilotChatPanel.vue`, `copilotChat.ts`,
  `CopilotCard.vue`, `ShortcutsModal.vue`, `docs/tbo-copilot.md`: the staff Copilot panel, 3 Nov). It was left
  untouched and is not in that commit, but the local vite build includes it.
- The shortcuts dialog (`ShortcutsModal.vue`) does not list `j` / `k` / `/` / `[` / `]` yet, because that file has the
  other session's uncommitted changes.
- Deploy needs **migrate** (the patch).
