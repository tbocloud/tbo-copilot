# Phase 11: every ticket is a chat with Copilot

Status: plan written 28 Oct 2026; **approved 28 Oct 2026 (all six decisions as recommended), with the owner's addition below**; **built 28 Oct 2026** (see As built); the checkpoint on the demo bench is next.

**Owner's addition (28 Oct 2026):** "Also reflect Teams chat in the main Copilot TBO Support window, but the opposite is not needed; in Teams, inform the status of the ticket." So:
- the TBO Copilot panel in TBO Support shows the person's Teams chat with the bot too, each Teams message marked "in Teams";
- what is typed in TBO Support is not sent to Teams;
- Teams gets each ticket's **status**: the diagnosis, "May Copilot fix this?", a fix ready (to its approver), deploying, live and checked, failed or handed over, reopened, confirmed.

People's messages typed on the ticket page are not forwarded to Teams (this narrows decision 4).

**Owner's request (28 Oct 2026).** The Copilot dialog and its buttons are confusing. Handle each ticket as a chat:
- in TBO Support and in Teams;
- Copilot explains the problem and the fix;
- buttons come inside the chat, user-friendly;
- the model remembers everything about the ticket while chatting and solving.

Press UAT is dropped for now (later).

**Owner's answers (28 Oct 2026):**
- **Ordinary fixes:** no "Let Copilot fix it" step. Copilot starts the fix by itself and asks once, when the fix is ready.
- **Database changes, high-risk code and sensitive areas:** Copilot asks before it edits, and asks again after, for the result.
- **Deploy:** "When approved, auto deploy."
- **Teams:** personal chat only.
- **TBO Support:** a chat panel beside the ticket.

## Goal

One conversation per ticket, the same in TBO Support and in Teams, where Copilot narrates its work in plain words. Each
step offers one or two clear buttons, and people can type what they want. The two Copilot dialogs with their dozen
buttons go away. Copilot remembers the whole ticket (what it found, what it tried, what people told it) whenever
anyone chats about it, and the worker gets the same memory when it fixes.

## What it looks like (ticket 0101 as the example)

On the ticket page, a **Copilot** tab beside the ticket shows:

> **Copilot** · Looking into it: the margin check on Sales Invoice fails since 27 Oct 13:45.
> **Copilot** · Found it (95% sure): `get_minimum_margin` was removed from Alpha Discount Settings.
> It is a bug in alpha_trading, not a customer mistake. I am fixing it now.
> **Copilot** · Fix ready: restores the method, plus a test that failed before and passes now.
> Checks: tests ✓, sandbox copy ✓, review ✓. Risk: low.
> [ **Approve** ] [ Ask for a change ] ··· (Open the pull request · Reject)
> **The developer** · Approved.
> **Copilot** · Merged. Deploying to demo-alpha now.
> **Copilot** · Live and checked on demo-alpha. I told the customer and asked them to confirm.

Anyone on the ticket can type, for example "why not just change the setting?", "use the price list rate instead",
"tell the customer in Arabic" or "try again". Copilot answers from what it knows about this ticket, or does it: a
change request, a new fix, a draft reply with **Send to customer**.

In Teams, the same messages reach the people on the ticket in their personal chat with the bot, each headed
"#0101 · Sales Invoice will not submit". Replying to one continues that ticket. Pressing a button there is the same
as on the ticket page.

## Decisions (approved 28 Oct 2026, all as recommended; decision 4 narrowed by the owner's addition)

1. **When Copilot asks before editing.** *(Recommended.)* Before any edit when the diagnosis involves:
   - data or settings (`data_damaged_by_bug`, `wrong_setting`, or a correction of the customer's records);
   - a sensitive area (accounts, stock, payroll and tax, permissions, patches and migrations, integrations), told by the
     files and doctypes the diagnosis names;
   - a fix the diagnosis itself rates high risk;
   - a customization build (as today: a person starts it).

   It asks with **May Copilot fix this?** (Yes / Not now / Give it to a developer). Every other bug is fixed at once
   when the customer is at the Fix level.
2. **After the edit: one approval, as today.** The same rules apply:
   - a senior for sensitive work;
   - the decision is pinned to the exact commit;
   - the first decision wins;
   - nobody approves their own fix.

   The finished change is also re-rated, and a change that turns out sensitive or high risk goes to a senior even when
   it started as ordinary.
3. **Deploy after approval.** *(Recommended.)* It starts by itself:
   - low risk: at once;
   - high risk, sensitive, or a bench other customers share: the night window (21:00–06:00 Riyadh), unless a senior
     presses **Deploy now** in the chat.

   It still goes one deploy at a time, with Press's backup, the check after it, and Undo in the chat.
4. **Who gets a ticket's messages in Teams.** *(Recommended.)*
   - the agents assigned to the ticket;
   - the customer's developer;
   - the approver of a waiting fix;
   - anyone who wrote in the ticket's chat.

   Each person can press **Mute this ticket**. Copilot's chatter (investigating, merged) is shown in TBO Support only.
   Teams gets what needs a person or is news: the diagnosis, a question, a fix to approve, live, failed, reopened.
5. **The old dialogs go.** *(Recommended.)* The form-script Copilot dialog on the ticket and its buttons are removed.
   Rarely used actions move into a **⋯** menu on the message they belong to:
   - rate the diagnosis, cancel, start again;
   - refresh the site, mark deployed;
   - undo, the pull request.

   The TBO Copilot panel (Phase 6) stays for "what waits for me" and new work; its ticket messages link to the ticket's
   chat.
6. **Memory.** *(Recommended.)* Each ticket's chat is kept as long as the ticket. Copilot reads:
   - its last 30 messages;
   - a running summary of everything older;
   - the run's record, the known issue, and the customer's conversation.

   What people tell it ("use the price list rate") is also kept as an instruction, and the worker reads those when it
   investigates or fixes again.

## What changes, part by part

### H34 (helpdesk): the ticket's chat and its memory (≈ 3 days)

- HDS Copilot Chat gets `ticket`: one chat per ticket, shared by everyone, next to the personal chats. Messages keep
  author, channel (Web or Teams), card and links. Ticket chats are not pruned after 90 days.
- `copilot/thread.py`:
  - `post(ticket, card, audience)` writes to the ticket's chat, refreshes open ticket pages (realtime, ids only) and
    delivers to Teams per decision 4;
  - `receive(user, ticket, text, files)` takes a person's message with the ticket already known, so there is no
    "which ticket?".
- **Narration.** Each step of a run posts one plain message, written from fixed templates (no AI). The steps:
  - investigating;
  - the diagnosis, with what happens next;
  - "fixing it now" or "May Copilot fix this?";
  - the fix ready, with its checks and risk;
  - approved, merged, deploying (when), live and checked;
  - the customer confirmed, or reopened;
  - failed, handed over;
  - an explanation drafted, with **Send to customer**;
  - an estimate for a customization;
  - a correction to approve.
- **Answers and instructions** reuse the Phase 6 engine (`assistant.py`) with the ticket fixed:
  - questions are answered from memory;
  - a change request starts a new fix;
  - "tell the customer …" drafts a reply for a person to send;
  - approve and reject only as the approver.

  Every action runs as the person, logged as today.
- **Memory.** The chat's last 30 messages plus a running summary (`memory`, refreshed by the model when the chat grows
  by 20 messages and when a run ends) go into every answer, with the run record, the known issue and the customer's
  conversation. People's instructions are kept in a list on the chat. `run_context` gets `ticket_chat` (the summary
  and the instructions).

### H35 (helpdesk): fixing by itself, asking where it must, deploying after approval (≈ 2.5 days)

- **After a bug diagnosis** (Fix level), the router either starts the fix at once (`fixes.request_copilot_fix`, by the
  system) or posts **May Copilot fix this?** by decision 1 (`fixes.needs_asking(run)`: category, sensitive paths and
  doctypes from `risk.py` applied to the diagnosis's files and evidence, the diagnosis's own risk).
- **The fix's approval** is as today, plus the re-rating of decision 2 on the real change (`risk.py` on the diff
  already marks it).
- **After approval and merge,** `deploy.auto_request` deploys every approved fix by decision 3, not only listed
  categories: "now" for low risk, "tonight" otherwise. Corrections are applied right after their senior's approval, as
  today.
- **Settings** (HDS Copilot Settings → Pilot):
  - **Copilot starts fixes by itself** (on);
  - **Deploy approved fixes by themselves** (on).

  Off brings back today's buttons in the chat.

### H36 (helpdesk desk): the Copilot chat beside the ticket (≈ 3 days)

- `desk/src/components/ticket-agent/CopilotThread.vue` is a **Copilot** tab in the ticket's side panel, beside Details.
  It opens first when the ticket has a Copilot run. On a phone it is the same sheet as Details.
- The panel shows:
  - Copilot's messages as cards: a title, a few plain lines, facts, at most two buttons, and the ⋯ menu;
  - people's messages as chat bubbles with name and time;
  - a box: "Ask Copilot or tell it what to do", with files.

  It updates live and keeps the draft while switching tabs.
- `hd_form_scripts/copilot_actions.js` is removed: the migrate deletes the form script it installed. The customer
  portal's banners are unchanged.
- Light and dark, phone width, keyboard and screen-reader labels, like the Copilot board.

### H37 (helpdesk): Teams, one personal chat, many tickets (≈ 1.5 days)

- Each ticket message sent to a person starts "#0101 · <subject>" and carries the ticket on its buttons.
- **Which ticket a reply in Teams belongs to:**
  1. the message the person replied to (Teams sends the quoted message's id with a reply);
  2. else a ticket number in the text;
  3. else the ticket of the last message they pressed or wrote about in the last 2 hours (Copilot names it in its
     answer, so a slip is visible);
  4. else Copilot asks.
- What they write lands in that ticket's chat and shows on the ticket page. What others write on the page reaches them
  in Teams by decision 4.
- **Mute this ticket** and **Unmute** per person.

### W13 (worker): the ticket's chat in the investigation and the fix (≈ 0.5 day)

- `context/ticket_chat.md` holds the chat's summary and people's instructions, inside the untrusted wrapper.
- The prompt: follow the people's instructions unless they conflict with the rules, and say so when they do.

### H38: docs, tests, checkpoint (≈ 1.5 days)

- `docs/tbo-copilot.md` gets a Ticket chat section. The Phase 6 and Copilot board docs are updated.
- Tests:
  - narration per step;
  - ask-before rules;
  - auto start and auto deploy by risk;
  - memory and its summary;
  - instructions reaching `run_context`;
  - Teams reply routing (quoted, number, current, ask);
  - mute;
  - permissions (a person who cannot read the ticket sees nothing of its chat, in Teams either);
  - removing the form script.
- The page is checked in headless Chrome as for Phase 10.

## Out of scope (later)

- The customer's own chat (Phase 5) is unchanged. This chat is internal: the customer sees only what a person sends.
- Teams threads per ticket in a channel (the owner chose personal chat).
- Press UAT (dropped for now).

## Checkpoint (on the demo bench, with the developer)

1. A planted demo bug is reported from Teams. In the ticket's chat (page and Teams), Copilot narrates:
   investigating, then diagnosis, then "fixing it now", with no button pressed.
2. The fix comes back with its checks, and the developer gets "#00xx · fix ready" in Teams. He asks "why this way?" and gets an
   answer that uses the ticket's memory. He presses Approve, the deploy starts by itself, and "live and checked"
   arrives.
3. A data correction asks before (**May Copilot fix this?**) and again after (the senior's approval), then is applied.
4. "Use the price list rate instead" typed on the page reaches the next fix as an instruction, and the worker's context
   shows it.
5. A reply in Teams without a ticket number goes to the right ticket, and a muted ticket stays quiet.
6. The ticket page has no Copilot dialog and no button bar. Everything is in the chat, in light and dark and on a
   phone.

## Risks

- **Fixes start without a person.** Mitigation: only ordinary bugs at the Fix level. The fix still runs on a sandbox
  copy and needs its one approval before anything merges. Each customer's monthly budget and the fix caps hold.
- **Deploys right after approval during working hours.** Mitigation: only low risk goes at once; the rest waits for the
  night window. Press's backup, the check after it, and Undo stay.
- **Too many Teams messages.** Mitigation: Teams gets only what needs a person or is news (decision 4), and each person
  can mute a ticket.
- **A reply in Teams goes to the wrong ticket.** Mitigation: the quoted message first, then the number. Copilot names
  the ticket it took, and the person can correct it.
- **Memory grows.** Mitigation: the last 30 messages plus a summary; the summary is refreshed by the model.
- **Changes in the helpdesk maintainer's ticket page.** Mitigation: a new component in the side panel, one tab, and one removed form
  script.

## What TBO must provide

| Needed | For | When |
|---|---|---|
| The approval of this plan and its 6 decisions | everything | now |
| The demo hub redeploy after the build | the checkpoint | after the build |
| The developer for the checkpoint | Teams parts | at the checkpoint |

Estimate: about **12 days** (H34 3, H35 2.5, H36 3, H37 1.5, W13 0.5, H38 1.5).

## As built (28 Oct 2026)

**Helpdesk `tbo-copilot` (pushed):**
- **H34 `copilot/thread.py`.**
  - One HDS Copilot Chat per ticket (`channel` Ticket, `ticket` unique). Its other fields: `memory`, `memory_through`, `instructions`, `muted`; and on a person's Teams chat, `current_ticket` and `current_ticket_at`.
  - HDS Copilot Chat Message gets `via`.
  - Narration (`on_state` from `runs._move`, which replaces the old `tell_news`; `on_diagnosis` from the router; `on_fix_ready` and `on_correction_ready` from approvals; `on_deploy` from `request_deploy`; `on_fix_failed`; `on_explanation` from `draft_explanation`) is posted from fixed templates. The status messages reach `on_ticket` people, headed "#0101 · subject" with Mute.
  - `receive`/`press` run the Phase 6 engine with the ticket fixed, plus the actions table (start, cancel, fix_yes, not_now, to_developer, build, deploy tonight/now, cancel_deploy, mark_deployed, refresh_fix, create_task, prepare_correction, undo_fix, undo_change, rate right/partly/wrong, kb_draft, send_reply, change, mute, unmute). Each one calls the existing `api.copilot` functions as the person.
  - Memory: `memory_for` (summary + instructions + the last 30 messages) goes into every answer. `summarise` is a background model call every 20 messages and when a run ends. `for_worker` becomes `run_context.ticket_chat`.
  - `assistant.prune` keeps ticket chats.
- **H35.**
  - `fixes.needs_asking` (the settings, a data or settings cause, a high-risk proposal, `risk.SENSITIVE_PATHS` on the proposal's files and the code evidence).
  - The router starts the fix by itself unless asking, and `copilot_writes_fixes` is no longer read.
  - `deploy.auto_request` deploys every approved fix (low risk now, high risk or sensitive tonight). `request_deploy(auto=True)` lets the approver's approval go now without a senior; a shared bench still needs a senior approver and goes tonight. A skipped automatic deploy says why in the chat.
  - Settings: **Ask Before Every Fix** and **Deploy Needs a Press**, both off. They are named so that an existing site gets the new way without a migration default. `make_copilot_settings` in the tests defaults both on, so the older tests keep the old flow.
- **H36.**
  - `CopilotCard.vue` (shared with the TBO Copilot panel) and `CopilotThread.vue`.
  - `TicketSidebar.vue`: Copilot and Details tabs; it opens on Copilot when the ticket has a run, and the person's click wins.
  - `MobileTicketAgent.vue`: Copilot is the first tab.
  - The form script "Helpdesk Copilot Actions" is removed on migrate (`form_scripts.RETIRED`), and its JS file is deleted.
- **H37.**
  - `teams.quoted_ticket` reads the reply's quote (HTML blockquote `itemid`, or `replyToId`) and finds the recorded message's ticket. `teams.ticket_reply` answers it in the ticket's chat.
  - `assistant.receive` falls back to the person's current ticket (2 hours) for question, change, fix or build, and says "About ticket 0101". `thread.mirror` copies ticket talk into the ticket's chat.
  - `assistant.history(Web)` merges the person's Teams chat, marked "in Teams" (the owner's addition). The panel is not sent to Teams.
- **H38.**
  - `docs/tbo-copilot.md`: a Ticket chat section, and the dialog mentions are updated.
  - `test_copilot_thread.py` (15 tests).
  - Updated tests: assistant (headed diagnosis), fix_jobs (the Phase 11 setting), pilot (the level test), form_scripts (the dialog removed).
  - 16 Copilot modules pass. `test_copilot_deploy.test_it_is_no_other_customer_and_never_moves` fails only in its known 21:05–24:00 Riyadh window; it fails the same way on the code before Phase 11.
- **Checked in headless Chrome on tbo.localhost**, as a temporary agent removed afterwards with its chat. Ticket 0102 opened on the Copilot tab. A question typed in the chat got a real answer from the ticket's record ("the fix stopped because sending email needs the Email Account…"). Light, dark and phone views were checked, with no console errors. Fixed along the way: the tab default (the injected ticket is a computed ref), the state line when a failed fix may be retried, a link to the same ticket inside its own chat, the link colour, and the phone height.

**Worker W13:** added to a tbo-copilot pull request (no stacked PRs): `context/ticket_chat.md` (data in the wrapper), the INDEX line, and the investigation and fix prompts. 144 unit tests pass.

**Deviation:** the ⋯ menu sits on the chat's top card (what can be done now), not on each historical message. Old messages' buttons would be stale, so each message keeps only its own step's buttons.

**Next:**
1. Redeploy the demo hub and migrate.
2. Merge a pull request and rebuild the worker.
3. Run the checkpoint with the developer.
