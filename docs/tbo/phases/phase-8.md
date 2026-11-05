# Phase 8: Copilot builds approved customizations

**Status:** plan written 19 Oct 2026; **approved by the owner 20 Oct 2026 with every recommended decision**; **built 28 Oct 2026, checkpoint passed on the local pair the same day** (see As built); built after Phase 7, and switched on per customer after 5 Copilot fixes merged with no reopen. **Estimate:** about 7 developer-days:
H21 (a written scope in the estimate, ≈ 2), H22 (the build run, ≈ 2.5), W10 (the worker builds to a scope, ≈ 2), and
the checkpoint on the local pair (≈ 0.5). **Built on:** Phases 0 to 4 and 6 (helpdesk `tbo-copilot`), and the
`customization_request` category in the worker (a pull request, waiting to be merged). **Asked for by the owner** on 19 Oct
2026, after ticket 0101 ("require a Sales Team row on Sales Invoice"): Copilot explained it as a customization, and
nothing more could happen.

## Goal

The customer approves the estimate for a small customization. A person then presses **Build with Copilot**, and
Copilot builds exactly what the customer approved, in the customer's own app. It tests the change on a sandbox copy
and opens a pull request. From there it is the same path as a Copilot fix: one approval, merge, a controlled deploy, and
the customer confirms or reopens. Nothing reaches the customer's site without that approval.

## What exists today, and what it means for this phase

| Found (19 Oct) | Consequence |
|---|---|
| The investigation reports `customization_request` → Explaining, with an offer of an estimate; **Start estimate** makes the ticket a Customization with Copilot's hours (`api.copilot.start_estimate`) | The starting point. Today the run ends at Answered, and the customer sees "With our team" |
| The estimate flow: `send_estimate` (hours, delivery date, a note of up to 500 characters) → the customer approves on the portal → the ticket's agents are told "Create the task" | The customer approves hours and a date, not a written scope. The note is too short to describe what will be built |
| The fix flow: Preparing Fix → fix Task → worker fix job (a test that fails before the change and passes after, a review, a pull request "Closes TASK-…") → approval bound to the head commit → merge → deploy → check → Resolved → Confirm / Reopen | Reused whole. Only the entry and the worker's instructions differ |
| Risk rules: `hooks.py`, doctype JSON and `accounts/**` are high risk, so a senior approves | Unchanged. Most customizations touch `hooks.py`, so most get a senior approver |
| Copilot level per customer: Fix and above may write code | The same gate applies to builds |

## Decisions in this plan (approved 20 Oct 2026, all as recommended)

1. **A person starts the build.** After the customer approves, an agent presses **Build with Copilot** on the ticket,
   in Teams or in the Copilot panel. *(Recommended.)* Starting automatically on approval comes later, after enough
   successful builds.
2. **Small customizations only:** estimates up to **8 hours** (setting `max_build_hours`). *(Recommended.)* Bigger
   ones go to a developer, as today.
3. **The customer approves a written scope, not only hours.** The estimate gets two new parts, shown in the email and
   on the portal: **What we will build** and **Done when** (one check per line). Copilot builds to that text. If the
   scope changes after the customer approved it, the estimate goes out again. *(Recommended.)*
4. **Customizations live only in the customer's custom app**: Python, hooks, and Custom Fields or Property Setters as
   fixtures. They are never made by hand as settings on the live site, so every one has a pull request, a review and a
   deploy record. *(Recommended.)*
5. **Billing is unchanged:** the customer pays the approved estimate, whoever builds it. The card records Copilot's
   cost next to the estimated hours, so you can see the margin. *(Recommended; this is your business decision.)*
6. **When to build it:** after Phase 7 (CI/CD). Switch it on per customer only after the pilot has at least 5 Copilot
   fixes merged with no reopen. *(Recommended.)* The alternative is to build it now, before Phase 7.

## What you will see at the end (ticket 0101 as the example)

1. Copilot reports a customization request and drafts the reply with its scope questions. The agent edits and sends
   it.
2. The customer answers. The agent presses **Start estimate**. The hours, **What we will build** and **Done when**
   are filled in from Copilot's proposal. The agent corrects them with the customer's answers and sends the estimate.
   For example:
   - *What we will build:* a Sales Invoice cannot be submitted without at least one row in Sales Team. The message
     says "Add at least one Sales Person in the Sales Team table." It applies to normal and POS invoices, and not to
     credit notes (returns).
   - *Done when:*
     - a normal invoice without a Sales Team row cannot be submitted;
     - a credit note without one can;
     - an invoice with one Sales Person submits as before.
3. The customer approves on the portal, or an agent records an approval given by phone or email.
4. The ticket's agents are told "estimate approved, Copilot can build it". The Copilot card shows **Build with
   Copilot**, also in Teams and in the panel. Pressing it creates a Task "Copilot build: …" in the customer's project
   (or uses the ticket's open task), and the run moves to Preparing Fix.
5. The worker builds the change on the sandbox copy. Each Done-when check gets a test that fails on the unchanged code
   and passes after the change. A review follows, then a pull request "Closes TASK-…" with the scope in its
   description.
6. The approval card shows **what the customer approved** next to **what changed**, and each Done-when check with its
   test result. Approve and Reject work as for fixes, with a senior approver when the change touches `hooks.py` or
   accounts.
7. Merge, then Deploy (pressed by a person, in the night window), then the check after the deploy. The customer gets
   "Your change is live, please check" with the scope, and Confirm or Reopen. Reopen goes to a person.

## What changes, part by part

### H21 (helpdesk): a written scope in the estimate (≈ 2 days)

- New HD Ticket fields (`install.py`): `custom_estimate_scope` ("What we will build", long text),
  `custom_estimate_checks` ("Done when", one per line) and `custom_estimate_scope_hash`. The 500-character note stays
  for remarks.
- `send_estimate` takes the scope and the checks. `estimate_message`, the customer's approval banner and
  `get_estimate` show them, and the agent's estimate card gets the two fields.
- `start_estimate` fills them from the run's proposal: the worker's `scope` and `done_when` when it gave them, else
  its proposal text.
- `decide_estimate` stores the hash of the hours, scope and checks that the customer approved. A scope edited
  afterwards no longer matches, so a build needs the estimate sent again.
- Tests in `test_customization_estimates.py`.

### H22 (helpdesk): the build run (≈ 2.5 days)

- `fixes.request_build(run, user)` refuses the build unless all of these hold:
  - the run is a `customization_request`;
  - the estimate is Approved and its hash still matches;
  - the hours are within `max_build_hours`;
  - the customer is at the Fix level or above;
  - `build_enabled` is on;
  - the customer's repositories are known;
  - no pull request is open.

  When they all hold, it stores `build_scope` on the run (scope, checks, hours, who approved and when, the hash). It
  then moves the run Answered → Preparing Fix (a new transition, agents only), creates the Task (prefix "Copilot
  build: ") or uses the ticket's open one, and queues the job through `request_copilot_fix`. A run that was closed in
  the meantime gets a new run of kind `code`, which copies the investigation and starts at Preparing Fix.
- `api.copilot.build_customization(ticket)` (POST, write permission on the ticket):
  - the Copilot dialog shows **Build with Copilot** with the scope and hours, or the reason it is not possible;
  - the staff assistant gets the same action behind its confirmation card ("build ticket 0101");
  - when a customer approves the estimate of a buildable customization, the ticket's agents are told so.
- `fix_context` gains `build: {scope, checks, hours}`, and the job's budget is `max_build_usd`.
- The approval payload includes the scope hash. The card and the Teams fix card show the scope and the result of each
  check.
- Customer stage texts for builds: "Working on your change", "Your change is scheduled for …", "Your change is live,
  please check". These are message templates for `customization_request`.
- Settings:
  - `build_enabled` (default off);
  - `max_build_hours` (default 8);
  - `max_build_usd` (default twice `max_fix_usd`).
- The weekly pilot report adds builds started, merged and reopened, and Copilot's cost against the estimated hours.
- Tests: `test_copilot_build.py`, about 15. They cover each refusal (no approved estimate, a scope edited after
  approval, too big, below Fix, switched off, an open PR), task reuse, the fix context, the payload hash, the stage
  texts, and reopen → a person.

### W10 (worker): build to a scope (≈ 2 days)

- Customization reports may carry `scope` and `done_when`, and `checkReport` accepts them.
- `fix-prompt.ts` gets a build variant:
  - build exactly the scope, in the customer's app;
  - write one test per Done-when check that fails on the unchanged code and passes after;
  - change nothing outside the scope;
  - ship Custom Fields and Property Setters as fixtures.
  It stops and explains instead of building when the scope needs a change to Frappe or ERPNext itself, a new
  integration or secrets, or when it is unclear. That case is reported as not built, and the Task goes to the
  developer with Copilot's notes, as a failed fix does.
- The fix report adds `check_results` (check, test, before, after). `checkReport` requires every check to be covered,
  or marked "not testable" with a reason.
- The review prompt also compares the diff with the scope: anything beyond the scope is a finding.
- The pull request description gets a Scope section and a Done-when table.
- Tests: the build prompt, `checkReport` cases, and an end-to-end run with a scripted model that builds a small scope
  on the demo app.

## Out of scope (later)

- Starting the build automatically when the customer approves.
- Customizations above 8 hours.
- Correcting existing records together with the build (a change set after the deploy, as for "a bug damaged the
  data").
- A Press UAT site where the customer tries the change before production (`system-design.md` §5.6).

## How it is built, run and tested

The same way as the earlier phases:

- helpdesk on the `tbo-copilot` branch, with module tests on the local site with `hold_commits`, one module at a time;
- the worker as one pull request into `tbo`, never stacked;
- the checkpoint on the local pair before anything is pushed.

## Checkpoint (on the local pair)

- **The main path**, on a customization ticket for the demo app ("require a Sales Person on Sales Invoice"):
  1. The investigation reports `customization_request` with a scope.
  2. Start estimate fills the scope; the agent sends it; the customer approves on the portal.
  3. Build with Copilot produces a pull request whose three checks each fail before the change and pass after.
  4. The approval card shows the scope next to the change; the approver approves; the pull request merges.
  5. The deploy is marked done by hand on the local pair, and the customer confirms.
- **Refusals:**
  - a scope edited after the approval is refused until the estimate is sent again;
  - a 12-hour estimate is refused and goes to a developer;
  - a customer at the Explain level is refused;
  - a worker report of "not built" sends the Task to the developer with Copilot's notes.

## Risks

| Risk | Mitigation |
|---|---|
| Copilot builds more or less than was agreed | Every Done-when check is a test. The reviewer compares the diff with the scope. The approver sees both side by side, and the customer confirms or reopens |
| The customer meant something other than what was written | The scope is in plain words in the estimate they approve. Reopen goes to a person |
| A customization in `hooks.py` runs on every save of that document | High risk, so a senior approves. The module tests run in the sandbox, and the check after the deploy looks for new errors |
| The build fails halfway | `max_fix_attempts`, then the Task goes to the developer with Copilot's branch and notes, as for fixes |
| Billing questions when Copilot is faster than the estimate | Decision 5 |

## What TBO must provide

- The decisions above.
- a pull request merged, and the worker server rebuilt (it brings `customization_request`).
- Nothing new from Microsoft, AWS or GitHub: the GitHub App, the worker and Press are reused.

## As built (28 Oct 2026)

**Pushed:** helpdesk `tbo-copilot` (H21, H22; main merged in). The worker's W10 is a pull request into `tbo`. Tests: `test_copilot_build.py` 17, the scope cases in `test_customization_estimates.py` and `test_copilot_pilot.py`; all 31 Copilot-related modules pass. Worker: 138 unit tests; end to end, engine 10 and fix 8, including a scripted build.

**How it differs from the plan, and why:**

- **No Start estimate button** (the owner, at the checkpoint): when a live run finds a customization request, the estimate starts by itself with Copilot's hours (unless triage or an agent estimated it already) and its draft of the scope and checks, ready on the estimate card for an agent to check and send. The button was also hidden whenever triage had estimated the ticket first, so the scope never reached the card. Shadow runs leave the ticket alone.
- **Not every check fails before the change.** A check that already holds (in the plan's own example, "a credit note without one can") cannot fail on the unchanged code. The worker requires every test module to pass after the change, at least one to fail on an assertion before it, and none to error there; each check is reported as "fails before, passes after", "holds before and after", or not testable with its reason. Checks are judged per test module.
- **A build reuses the fix's path whole:** the run keeps `build_scope`, the fix job's context gets `fix.build` and the budget `max_build_usd` (blank: twice the cap per fix), the approval payload carries the scope and binds `scope_hash` into `payload_hash`, and the customer's stage texts are built in (`settings.BUILD_TEMPLATES`), not message-template rows.
- **The staff assistant** builds on "build ticket 0101", behind Yes, as planned. The Teams fix card of a build shows what the customer approved and each check's result.

**Checkpoint (local pair, 28 Oct):** ticket 0102 ("Require a Sales Person on Sales Invoice", customer Build Demo Co on the sandbox repo). The estimate started by itself (3 checks), the agent sent it, and the customer approved it on the portal API. Build with Copilot made the task "Copilot build: …". The worker's part was played with the real GitHub App push key and real tests (two fail before and pass after, one holds), giving sandbox a pull request. The approval showed the scope next to the change; the owner approved; the hub merged it 5 seconds later. Then Mark deployed, and the customer confirmed: Closed. Refusals: a scope edited after the approval (0103), a 12-hour estimate (0104), a customer at Explain (0105), and a worker's "not built" (0106: the task gets Copilot's notes). The AI's own part (writing the change from the scope) is covered by the worker's end-to-end test with a scripted model; the first real build runs on the demo bench after the redeploy and the worker rebuild.

