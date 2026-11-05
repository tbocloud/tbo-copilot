# Phase 14: the support chat, as in the prototype

Status: plan written 31 Oct 2026; **approved and built 1 Nov 2026** (owner: "built it and push"; all decisions as recommended): helpdesk_client `tbo-copilot` and helpdesk `tbo-copilot` (merged with main), **pushed 1 Nov 2026** (see As built). The checkpoint on the demo bench is next.

**Owner's request (31 Oct 2026):** after reviewing the support sidebar prototype ("yes its good continue with it"),
bring its new parts to the real customer app. The prototype is a design reference, not code to copy: a private
page and its source
(React, mock data). `helpdesk_client` stays plain JavaScript on the Frappe desk, as in Phase 13.

## 0. What is new, and what already exists

Phase 13 already gives the client the Support page and panel from the owner's screenshot. These stay as they are:

- the rail: **+ New chat**, **Action needed (n)** with the team's question, **Tickets** with their dots;
- every ticket is a chat, with its status line, **What's the status?**, **It's fixed** / **Still broken**;
- the message box: **Attach**, **Record screen**, **Send a form instead**, **Send**;
- before raising, TBO Support shows **Here is what I'll send to our team** with **Raise the ticket** / **Change
  something** (the prototype's editable draft does the same job; see decision 4);
- the greeting already names the record the user is on, and the model already sees the page and recent errors.

New in this phase, from the prototype:

| # | What | Where |
|---|---|---|
| 1 | **Get help** on every form, and **Get help with this error** on error messages | site + hub |
| 2 | The ticket remembers its record: a link in the ticket's chat, and a **Support** strip on the record's form | site |
| 3 | A **Screenshot** button in the message box | site |
| 4 | Better screen recording: a floating bar (time, mute, discard, stop), a time cap, a preview before sending | site |
| 5 | **Send a form instead** starts from what the user typed, and opens the new ticket's chat at once | site + hub |
| 6 | **Similar open tickets** at the company, with **This is my issue, add me to it** (decision 1) | site + hub |
| 7 | The panel: **Ctrl + /** opens and closes it, **Esc** closes it, it can be resized, and docks on wide screens | site |

## 1. What the client sees

**On every form**, a small **Get help** button in the toolbar (not on Support Ticket itself, not on print views).
It opens the panel on a new chat with a bar over the message box: "About Sales Invoice ACC-SINV-2026-00042 ✕".
The user can remove it. Their first message carries the record.

**On an error message** (Frappe's red message dialog, e.g. after Submit fails), a **Get help with this error**
button next to Close, with a line under it: "TBO Support gets the record's name and this message, not the record's
contents." Pressing it opens the panel and sends the record and the error at once:

```
┌ TBO Support ──────────────────────────────────────────────┐
│                     ┌──────────────────────────────────┐  │
│                     │ 📄 Sales Invoice ACC-SINV-…00042  │  │
│                     │ Submit failed: Row 7: the margin… │  │
│                     └──────────────────────────────────┘  │
│ ✦ I have Sales Invoice ACC-SINV-2026-00042 and the error, │
│   so you don't need to type them. Since when does it …?   │
└───────────────────────────────────────────────────────────┘
```

**The record stays with the ticket.** The ticket's chat header links to it ("📄 Sales Invoice ACC-SINV-2026-00042",
opening the form). The record's form shows a **Support** strip while a ticket about it is open: "Support ·
SUP-2026-##### · TBO Support is working on it", opening that ticket's chat.

**The message box** gains **Screenshot** between Attach and Record screen, on the panel and the full page.

**Recording:** after **Record screen**, a bar floats at the bottom of the screen, outside the panel, so the user can
close the panel and show the problem:

```
            ┌───────────────────────────────────────────────────────────┐
            │ ● Recording 0:42 / 3:00   🎤  🗑  [■ Stop and attach]      │
            │ Show the problem, then press Stop.                         │
            └───────────────────────────────────────────────────────────┘
```

The voice is recorded when there is a microphone, and can be muted. Recording stops by itself at the time cap or the
site's file size limit, and when the user ends sharing in the browser's own bar. The recording then waits in the
message box, where it can be played, and is sent with the next message. When TBO Support asked for a recording (its
**Record** button), stopping sends it at once, as today. Phones cannot record the screen, so the button is hidden there.

**Send a form instead** opens the same form as today, already filled with what the user typed, their files and the
record. After **Raise Ticket**, the panel opens the new ticket's chat (in place of today's message with a link), and
the user can keep writing there.

**Similar open tickets (decision 1).** When TBO Support shows **Here is what I'll send to our team**, the site first
looks for open tickets from colleagues that look the same. Up to two show above the summary:

```
  Similar open tickets at your company
  SUP-2026-##### · Invoices blocked by the margin rule   🟠 Working on it   3 colleagues
  [This is my issue, add me to it]
  ─────────────────────────────────────────────
  Here is what I'll send to our team …   [Raise the ticket] [Change something]
```

**Add me to it** makes the user a follower of that ticket: it appears in their Tickets with its chat, they get its
notices, and the team sees "Aisha Rahman has the same problem" in that ticket. Nothing new is raised. Only the title,
status and number of colleagues show, never the description.

**The panel:** **Ctrl + /** (**⌘ + /** on a Mac) opens and closes it; **Esc** closes it and returns focus. Dragging
its left edge sets the width (360–640 px, remembered per browser). On wide screens it docks: the page shrinks beside
it, so a form stays visible while the user chats (decision 3).

## 2. How it behaves

- **Get help** calls the existing `chat.start` with `new=1` and the record. The open non-ticket chat is not lost: it
  stays under Chats, as Phase 13 keeps earlier chats.
- **The error button** reads the dialog's text (HTML removed, cut to 500 characters), the record, and the action
  when it is known (Save, Submit, Cancel, read from the form's save call). It shows only on red messages, once per
  dialog, and only when the chat is on.
- **What TBO Support does with it:** the record and the error are facts, so it does not ask for them again. "Records"
  is the record, "What happened" is the error, and "Steps" is "Press Submit on Sales Invoice …" when the action is
  known. The model asks only what is missing (since when, one record or many, what was expected).
- **The record on the ticket:** a ticket raised from the chat now copies the chat's record onto the site's Support
  Ticket (`ref_doctype` / `ref_docname`, which form tickets already have).
- **Screenshot** uses the same capture as the form's **Capture Screenshot** (one frame of the shared tab), and
  attaches the image to the message box.
- **The form's chat** opens through Phase 13's `chat.open_ticket`. With this phase's hub change it is live at once;
  with an older hub it is read-only until TBO Support picks the ticket up, as today.
- **Similar tickets** are searched on the site, among open Support Tickets raised by other users: words of the summary's
  title and "what happened" against their subject, and the same record or DocType counts extra. HR and payroll
  tickets are never shown (decision 2). **Mine is different** is simply **Raise the ticket**.

## 3. What changes in TBO Support (the hub)

- **H45, the record and the error:** the chat's start context accepts `shown_error` and `error_action`. The greeting
  says what it has, the facts above are filled from them, and the ticket's description includes the error. A hub
  without H45 ignores the new keys, and the chat works as today.
- **H46, a form ticket's chat at once:** `open_ticket` imports a form ticket the hub has not pulled yet (that one
  ticket, from the site that asks) and then links the chat. Today it waits for the next pull.
- **H47, joining a ticket (decision 1):** a `joined` action closes the chat without raising anything and notes which
  ticket the customer joined. The site posts "… has the same problem" in that ticket's chat, which the team sees as a
  customer message. A hub without H47 refuses `joined`; the site then keeps the chat open, the user still follows the ticket on the site, and their own chat says TBO Support could not be told just now.

## Build (about 10 days; about 7½ without similar tickets)

| Code | What | Days |
|---|---|---|
| C14 | **Get help** on forms (`form-refresh`), **Get help with this error** (`frappe.msg_dialog.add_custom_action` on red messages, the save call's action), the record bar in the message box, `chat.start` with the error; the record on chat tickets (`_ticket_for`); the record link in the ticket's chat; the **Support** strip (`frm.dashboard.set_headline`) | 2 |
| C15 | **Screenshot** in the message box; recording: floating bar (time, mute, discard, stop), time cap (setting, 3 min), the recording waits in the message box with a player | 1½ |
| C16 | **Send a form instead** filled from the message box and the record; after **Raise Ticket**, open the ticket's chat | ½ |
| C17 | Similar open tickets: site search, the card above the summary, followers on Support Ticket (they see it in Tickets, get its notices), **Add me to it** (decision 1) | 2 |
| C18 | The panel: Ctrl + / and Esc, resize and remember the width, docking on wide screens (decision 3) | 1 |
| H45–H47 | Hub: the record and error as facts; `open_ticket` imports a form ticket at once; the `joined` action | 1½ |
| C19/H48 | Tests on both sides, docs (`helpdesk_client` README, `docs/tbo-copilot.md`), a walkthrough in headless Chrome on customer.localhost, the checkpoint on the demo bench | 1½ |

## Checkpoint

On demo-alpha, signed in as a customer user, with the demo hub as the hub:
1. A form's **Get help** opens a new chat with the record bar; the first message carries the record.
2. An error on Submit shows **Get help with this error**. The chat opens with the record and the error, TBO Support
   does not ask for them again, and the raised ticket shows the record in its chat. The form shows the **Support** strip.
3. **Screenshot** attaches an image. **Record screen** shows the bar, mutes, discards, stops at the cap; the recording
   plays in the message box and reaches the demo hub with the message.
4. **Send a form instead** starts filled. After **Raise Ticket** the ticket's chat opens, and a message there reaches
   the demo hub straight away.
5. A second user with the same problem sees the first user's ticket under **Similar open tickets**. **Add me to it**
   shows it in their Tickets, and the demo hub's ticket shows "… has the same problem". Nothing new is raised.
6. Ctrl + / and Esc work; the panel resizes, remembers its width and docks on a wide screen.

## Decisions for the owner

| # | Decision | Recommended |
|---|---|---|
| 1 | Similar open tickets from colleagues, with **Add me to it** | **Include** (C17, H47; about 2½ days). Without it, only the user's own tickets are checked, as in Phase 13 |
| 2 | Whose tickets can show as similar | Open tickets from other users on the same site; title, status and number of colleagues only; **HR and payroll never** |
| 3 | The panel over the page (today) or docked beside it | **Docked on screens 1280 px and wider** (the page shrinks); over the page below that, and always on the point-of-sale and print pages |
| 4 | The prototype's editable draft (fields marked "AI suggested" / "Needed") | **Keep TBO Support's summary card** (**Raise the ticket** / **Change something**): it already lets the user check before raising, and the model writes the fields |
| 5 | Where the form opens | **Keep today's form dialog** (it has recording, screenshots and "Attach what I did"); only fill it and open the chat after it |
| 6 | Recording | **3 minutes** at most, voice on when there is a microphone, mute in the bar |
| 7 | **Get help** on forms | A small button in every form's toolbar; not on Support Ticket or print views |

## Risks

- **Other apps change `frappe.msgprint` too** (themes; our own session replay wraps it). The error button hooks the
  dialog after it is shown, adds itself once, and does nothing when the dialog is not red.
- **The error text can name customers or amounts.** It goes only to TBO Support, which already receives the user's
  recent error logs; the dialog says so before the user presses the button.
- **Docking can squeeze pages built for full width.** Below 1280 px, on the point-of-sale page and on print views the
  panel stays over the page; anything else that breaks gets added to that list.
- **Similar tickets show colleagues' ticket titles.** A title can still say too much; decision 2 limits what shows,
  and the site setting can switch the feature off.
- **Older hubs:** each hub change has a fallback (the chat as today; the form ticket read-only until picked up; no
  `joined`: the user follows the ticket on the site and their chat says the team could not be told).
- **Ctrl + /** is free in Frappe (Frappe's shortcut list is Shift + /). If a customer app uses it, the shortcut is
  skipped there.

## As built (1 Nov 2026)

**Customer site (helpdesk_client):**
- **Get help** (`get_help.js`, from `form-refresh`) on every form except Support Ticket, Support Conversation and HDS Support Settings. It opens the panel on a new chat about the record; the chat starts with the first message, and the record bar can be removed before that.
- **Get help with this error** on Frappe's red message dialog (`frappe.msg_dialog.add_custom_action`), added once and removed when the dialog closes. It sends the message as shown (500 characters), the record and the action (Save, Submit, Cancel, Update or Amend, read from the form's save call within 30 seconds). The error is the chat's first message ("Submit failed on …").
- **The record:** the chat stores `ref_doctype` / `ref_docname`; a ticket raised from it keeps them; the ticket's status line links to the record; the record's form shows a **Support** strip (`inbox.for_record`, cached 60 s).
- **The message box:** Attach, Screenshot, Record screen, Send a form instead, Send. Files wait in the message box until Send (an image can be viewed, a video played; too large ones are marked and block Send). `screen_tools.js` holds the shared screenshot capture, the recorder and its floating bar. The recorder stops at **Longest recording (minutes)** (new setting, 3), at the upload limit, or when sharing ends; a recording TBO Support asked for is sent when the user stops, as before.
- **Send a form instead** fills the form (text, screenshots, recording, record) and opens the new ticket's chat after **Raise Ticket**. `chat.open_ticket` now asks TBO Support for a ticket it has not picked up yet; with an older hub it stays read-only.
- **Similar tickets** (`similar.py`, new setting **Show similar tickets from colleagues**, on): up to two open tickets from other users that TBO Support has picked up, scored on the words of the chat and of TBO Support's summary (title words 2 each, description words 1 each up to 3, same record +4, same DocType +1; shown from 4). Never the user's own, followed, HR (hrms app, HR or Payroll module, or payroll words) or not-yet-picked-up tickets.
- **Followers** (new child table **Support Ticket Follower**): read the ticket and its chat (read only), see it in Tickets (never under Action needed, no It's fixed), and get its status and stage notices, also when it turns red for the raiser.
- **The panel:** Ctrl + / (not in code editors), Esc (focus back to the Support button), resizable 360–640 px (remembered), docked on screens 1280 px and wider except on the Support, point-of-sale and print pages.
- **Patch** `v15_0_6.support_chat_defaults`: existing sites get the two settings at their defaults (without it, the first save of the settings would store the Check as 0).

**Hub (helpdesk, merged with main):** H45, H46 and H47 as planned (`conversation._known_facts`, `_greet_error`, `_pull_now`, `_joined`).

**Different from the plan:**
- The **Support** strip is its own line above the form, not `frm.dashboard.set_headline`, which would replace ERPNext's own headline.
- A follower cannot write in the ticket's chat: the site and the hub both check that a chat belongs to the user writing in it. **Add me to it** tells TBO Support through the follower's own chat (`joined`, an internal note on the ticket), not with a message in the ticket's chat.
- A chat that ended without a ticket (answered, or joined) now hides the message box: "This chat has ended" and **New chat**.
- Closing the form any way (×, Esc) now ends its tour; before, only Cancel and Raise Ticket did, and the tour's popup stayed over the page.

**Tests:** site 124 in 14 modules (test_get_help 8 and test_similar 10 new; test_inbox's read-only test now expects the site to ask first). Hub on the merged branch: test_copilot_conversation 44 (7 new), customer 17, ticket_puller 16, follow_ups 34, ticket_intake 42. test_chatwoot_bridge was not run (no `hold_commits`; Phase 14 does not touch it).

**Walkthrough** in headless Chrome on customer.localhost as copilot.test, with tbo.localhost as the hub:
- Get help on a Customer form: the panel docked, the record bar, the hub's greeting named the record, and a real model answered.
- A real screenshot and a 7-second recording with a fake microphone (muted from the bar, played in the message box at 800×450), both carried into the form with the typed text.
- Esc, Ctrl + / and resizing; the error dialog's button and its note (none on a green message); the error chat ("I have Customer … and the error … Since when does this happen?").
- The similar card above a summary, and Add me to it (the hub did not know the walkthrough's ticket, so the "could not be told" path showed); the user then followed it.
- The full page's labelled buttons and record link; the phone width hides the capture buttons with no sideways scroll.

Screen capture needs https: the dev site is http, so the walkthrough marked it secure in Chrome; on http the two buttons hide. Everything the walkthrough made was removed on both sites (11 chats each, 2 tickets, a follower, 5 deleted-chat records), and the test runs' 40 Holiday List comments were deleted; both sites are back to their counts from before.

**Not done / to know:**
- The checkpoint needs the demo bench redeployed with **migrate** on both sites (new doctype, new fields, the patch).
- **The local hub tbo.localhost has no HD Tickets.** `test_hd_ticket`'s `setUp` runs `frappe.db.delete("HD Ticket")`; it was run on 31 Oct (about 13:51 hub time) during the Phase 13 tests and deleted every ticket there (every one of them); there is no backup. customer.localhost's SUP-2026-#####…00004 still name those numbers. Never run `test_hd_ticket` on a site that holds data.
- tbo.localhost's `shadow_mode` reads 0. These runs did not change it; earlier demos set it off at times.
