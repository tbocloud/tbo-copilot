# Phase 12: the ticket opens in the chat

Status: plan written 29 Oct 2026, revised the same day after the owner's answer; **approved 29 Oct 2026 (all six decisions as recommended)**; **built 29 Oct 2026** (helpdesk `tbo-copilot`, on top of a merge of `main`; see As built); the checkpoint on the demo bench is next.

**Owner's request (29 Oct 2026), about ticket 0101 on the demo hub:** "The UI is so bad and very messy. I want it fully
arranged. There are so many things that users may feel uncomfortable and confused."

**Owner's answer to the first mockup (29 Oct 2026):** "No removing the things, I want them neatly arranged. When a
ticket opens, the view must go to the chatbot view. In it, the message option is for the project coordinator, the
administrator and the corresponding developer the ticket is assigned to. The ticket must be assigned to an employee
who is not on leave. You can use different methods for that assigning; tell me which is better."

Mockup: a private page (the Chat tab, and the Customer tab with the ⋯ menu open).

## 1. The ticket page: everything kept, arranged in three places

**Header (one line):** back to Tickets, the number and subject, previous / next ticket, the **status**, the **assigned
person** (click to change), and one **⋯** menu. The ⋯ menu holds every other action, in three groups:
- **Customer site:** Login to site, View recordings.
- **Copilot and AI:** Start investigation, Run triage again, Copy fix brief, Download fix brief, Approvals (with a
  count when something waits).
- **Ticket:** Create task, Schedule Teams meeting, Merge with another ticket, Delete ticket.

**Three tabs under the header; the ticket always opens on Chat:**

| Tab | What it holds |
|---|---|
| **Chat** (opens first) | The customer's request at the top (their words, screenshot, the page they were on); who is in the chat; what Copilot needs now (one sentence, its buttons, its ⋯); then Copilot and the team talking: what Copilot found and did, the people's messages, why the ticket went to whom; the box to write in |
| **Customer** | The conversation with the customer: their messages, replies, Copilot's automatic updates to them, people's internal notes; filters All / Emails / Comments / Calls; the reply box (Reply / Internal note) |
| **Activity** | Everything that happened, including Copilot's internal notes and status and assignment changes |

**Details panel on the right, in closed sections with a one-line summary each:** Ticket (priority, team, type,
assigned, coordinator), Customer (company, contact), SLA, Customer site (login, recordings, page, record, roles, recent
errors), Work (task, pull request, estimate), AI help (triage, suggested reply, duplicate, similar and recent tickets),
Meetings. The Ticket section starts open.

The mobile page gets the same tabs, with Chat first and Details as a fourth tab.

## 2. Who can write in the ticket's chat

Writing in the chat (and pressing its buttons) is for:
- **the developer the ticket is assigned to** (its current assignees);
- **the project coordinators** of the customer's project (members whose project role is Project Coordinator);
- **administrators** (decision 3: which roles count).

Everyone else who may open the ticket reads the chat; the box tells them who can write. Approvals keep their own rule
(the approver assigned to the fix, a senior for sensitive changes). In Teams, the same people can answer a ticket's
status message; anyone else gets "Only the assigned developer, the coordinators and admins can write in this ticket's
chat."

## 3. Assigning tickets only to people who are working

**What happens today.** A new ticket goes to the customer's **ticket owner** (HD Customer), or to the **backup owner**
while the owner is on approved leave (HD Leave, synced from HR). When neither can take it, the team's **assignment rule**
(round robin, least load or weighted) picks someone. That rule only looks at the agent's status (Active, Away,
Unavailable), **not at leave**, and as a last resort it picks someone Unavailable. A ticket assigned before someone's
leave stays with them while they are away. Copilot keeps a separate "Assigned Developer" on the customer for hand-overs
and approvals.

**The methods:**

| # | Method | How it picks | Good | Weak |
|---|---|---|---|---|
| A | Customer owner + backup | The customer's own developer; the backup while the owner is away | Knows the customer and their apps; one face for the customer | When both are away, nobody; one busy owner gets everything of a big customer |
| B | Round robin | The team takes turns | Simple and even by count | Ignores how busy people are and who knows the customer |
| C | Least load | Whoever has the fewest open tickets | Spreads the work fairly | A developer who never saw the customer's code gets it |
| D | Project team, least load | The least busy developer on the customer's project team | Knows the customer and spreads the work | Needs each customer's project team kept up to date |
| E | By skill | Whoever knows the app or module Copilot's diagnosis names | The best fit | Needs a skills list per person; the area is only known after the diagnosis |
| F | The coordinator picks | A person assigns by hand, seeing who is on leave | Human judgement | Slow; tickets wait when the coordinator is busy |

**Recommended: a chain of A → D → C, every step skipping anyone on leave today**
1. the customer's owner, if working today;
2. else the backup, if working today;
3. else the least busy developer on the customer's project team who is working today;
4. else the least busy person in the support team who is working today;
5. else nobody: the ticket stays unassigned and the project coordinators get it in Teams and on the ticket ("Nobody
   is free: please assign").

"Working today" means: an active agent, not on approved leave today (a half day counts as working, as it does
today), and not set to Unavailable. Plus:
- **Every morning, right after the 06:15 leave sync from HR (and after a manual "Sync holidays now"),** the open
  tickets of anyone on leave that day move to the next person in the chain, with a line in the ticket's chat ("Moved to Vishnu: Rahul is on leave until 31 Oct"). They go back when
  the owner returns only if nobody has worked on them yet (decision 6).
- **The assign picker** shows "on leave until …" next to such people and does not offer them.
- **One field:** the customer's ticket owner is also Copilot's developer; the separate "Assigned Developer" field
  is filled from it and then retired, so the two never disagree.
- B and E are not needed now: C already spreads the work fairly, and E can be added later on top of D once Copilot's
  diagnoses name the area reliably.

## Build (about 6 days)

| Code | What |
|---|---|
| H39 | Ticket page: header with assignee and grouped ⋯ (the form script's actions move into it), tabs Chat / Customer / Activity opening on Chat, the customer's request card in the chat, Details in closed sections; the mobile page the same |
| H40 | Who may write: `thread.receive` and `thread.press` (web and Teams) allow the assignees, the project coordinators and the admins; the box and the Teams reply say who can write |
| H41 | Assignment chain: owner → backup → project team → team, all skipping leave; team rules skip people on leave and never fall back to someone Unavailable or on leave; morning hand-over of open tickets; the assign picker shows leave; Copilot reads the ticket owner |
| H42 | Docs (`docs/tbo-copilot.md`, `docs/ticket-owners.md`), tests, a walkthrough in headless Chrome, the checkpoint on the demo bench |

## Checkpoint

On the demo hub, with a developer on leave in HD Leave:
1. A new ticket for their customer goes to the backup; the chat says why.
2. With owner and backup both on leave, it goes to the least busy working developer on the project; with nobody
   free, the coordinator is asked in Teams.
3. The ticket opens on Chat; the developer, the coordinator and an admin can write; another agent can only read.
4. Every action that was on the old page is still reachable (header ⋯, tabs, Details sections).

## Decisions for the owner

| # | Decision | Recommended |
|---|---|---|
| 1 | Layout | Header + ⋯ in three groups; tabs Chat (first) / Customer / Activity; Details in closed sections |
| 2 | Who writes in the chat | Assigned developer, project coordinators, admins; others read |
| 3 | Who counts as admin | Agent Manager and System Manager roles |
| 4 | Assignment method | The chain A → D → C, skipping leave; coordinators asked when nobody is free |
| 5 | Tickets of someone who goes on leave | Move each morning to the next in the chain |
| 6 | When the owner returns | Moved tickets go back only if nobody worked on them yet |

## Risks

- A customer with no project team, owner or backup falls straight to the team's least-load step; the plan lists such
  customers on the board so they can be filled in.
- HD Leave comes from the HR sync at 06:15 each day; a leave approved later in the day counts from the next morning,
  unless someone presses "Sync holidays now".
- The form script's buttons move into ⋯ with the next helpdesk deploy (the form script is installed on migrate).

## As built (29 Oct 2026)

helpdesk `tbo-copilot` (on top of a merge of `main` with its 8 new commits).

- **Page:** `TicketViews.vue` holds the tabs Chat / Customer / Activity, and every ticket opens on Chat
  (`modalStates.ticketView`). Reply and the AI suggested-reply card switch to Customer with the composer open.
  The chat starts with the customer's request (`ticketRequest.ts`) and "In this chat: Copilot · people · Admins".
  The Customer tab has filters All / Emails / Comments / Calls and leaves out Copilot's own notes
  (`get_comments` flags them `by_automation`); Activity shows everything.
  - The header shows the assignee (`AssignTo`); its ⋯ menu has Customer site, Copilot and AI (the form script
    now returns groups instead of buttons) and Ticket.
  - Details folds Contact, SLA, Linked work and Session replay, with a summary line on each
    (`PanelSection.summary`).
  - The phone has Chat, Customer, Activity and Details, and the reply bar is hidden on Chat.
- **Who writes:** `thread.may_write`, `OPEN_VERBS` (approve, reject, snooze, show_fix, the release verbs,
  mute, unmute), `thread.people`, and `now.can_write`. Someone who may only read gets a refusal card that is
  not recorded; `mirror` skips them.
- **Assignment:** `helpdesk/ticket_assignment.py`.
  - The chain runs owner → backup → project team (Developer and Support Engineer roles, least busy) → the
    team rule.
  - The team rule for HD Ticket (`get_ticket_user`) only picks people working today, Active before Away,
    least busy first, and never someone on leave or Unavailable.
  - `ask_for_unassigned` runs every 10 minutes. It covers tickets created 5 minutes to 2 days ago and asks
    once per ticket (cache key: ticket + creation): coordinators first, else admins.
  - `daily` runs at 06:30 and after Sync holidays now. It does `give_back`, then `hand_over_from_leave`. The
    new fields `custom_away_assignee` and `custom_moved_on` hold the move.
  - Each step leaves a note line in the chat (card tone "note", shown centered).
  - `ticket_owner_today` now also passes over an owner set to Unavailable.
  - The picker refuses people on leave all day (`onLeave.awayAllDay`).
- **Copilot's developer:** `ticket_assignment.developer_of` replaces the 6 reads of
  `custom_assigned_developer`. That field is hidden, and the patch `copilot_developer_is_ticket_owner` copies
  it into empty owners.
- **Tests:**
  - new `test_ticket_assignment` (19);
  - `test_copilot_thread` (15): its two button tests now assign the approver first;
  - also passing: ticket_owners 23, new_assignments 15, exact_assignment 5, ticket_intake 40, sales_wall 14,
    offboarding 18, ticket_puller 16, client_sync_backoff 8, teams_meetings 25, chat_notifications 20,
    copilot_form_scripts 1, leads 37;
  - Copilot suites also passing: approvals 7, customer 13, fix_flow 35, shadow_mode 18, watch 16,
    assistant 45, conversation 28, fix_jobs 14, board 11, mcp read 10 and write 8, releases 45, deploy 22,
    pilot 25.
  - No leftovers.
- **Checked in headless Chrome** on tbo.localhost (desktop and phone, an admin and a reader); no console
  errors.

**On the demo bench after the deploy:**

- The migration copies each customer's Copilot developer into an empty ticket owner, so new tickets of those
  customers get assigned.
- In the first 10 minutes, unassigned customer tickets from the last 2 days are brought to the coordinators
  or admins, once each.
