# TBO Copilot: build plan and status

Design: `system-design.md`. Phase plans: `phases/`. Section numbers continue from the design document. Updated at the end of every work session.

| Phase | Content | Status | Plan |
|---|---|---|---|
| 0 | Groundwork and fixes | Code done locally, now pushed 9 Oct 2026 to the `tbo-copilot` branch of each repo (helpdesk_client C1 7b091bb, C2 4eeceba; helpdesk after the 9 Oct rebase onto main 8816ca6: H1a d8ff85d + 1b42b98, H1b 349cdfb); seed tickets and the evaluation list written (`evaluation/tickets.md`); waiting: AI keys + OpenAI model name from the owner, real ticket numbers for the evaluation list, checkpoint 5 (fallback), task numbers, push | `phases/phase-0.md` |
| 1a | Hub foundation + customer stages | Built 9 Oct 2026, checkpoint passed on the pair; pushed 9 Oct to the `tbo-copilot` branch of each repo (helpdesk, rebased onto main 8816ca6: H2 dc96f38, H3 d16875b, H6a c8f1849, H6b 8457741 + 7803d4e; helpdesk_client C3 08c06dd, C4 b60728e); UI click-through by the owner pending | `phases/phase-1a.md` |
| 1b | Hub MCP server (TASK-2026-00013) | Built and checked 9 Oct 2026; pushed to `tbo-copilot` in both repos (helpdesk f648e2f, helpdesk_client 88f97f0); desktop app check by the owner pending | `phases/phase-1b.md` |
| 1c | Worker + sandbox, shadow mode | Not started | — |
| 1d | One approval + merge | Not started | — |
| 2 | Controlled production deployment | Not started | — |
| 3 | Config and data changes (senior approval) | Not started | — |
| 4 | Pilot and hardening | Not started | — |
| Later | §5.6 features | Not started | — |

## 7. Build plan, step by step (revised after the owner's review)

Order: the **vertical slice first** (ticket → investigation → diagnosis → sandbox → PR → approval), then **controlled production deployment**, then **config and data changes under senior approval**. Each phase, and each step of Phase 1, gets its **own architecture and plan document that the owner approves before building** (§10). Each one ends with something you can see working on the local pair (`tbo.localhost` ↔ `customer.localhost`). PR codes: H = helpdesk, C = helpdesk_client, W = worker/fork. Estimates are developer-days; total ≈ 70 days, of which Phases 0–1 (≈ 57 days) give the first useful pilot.

**Phase 0: Groundwork (≈ 7 days)**
1. H1: the fixes in §5.1 (isError, status push diffs/labels, close via controller, approval row lock, `get_triage` permission, triage status options, fix-brief task reference, `pause_ticket`, `ai_engine` fallback provider).
2. C1 and C2: security hardening of the customer-site app; the detailed list stays private until every customer site runs the fixed version.
3. Set the hub's AI provider to Kimi (Moonshot International) with OpenAI as fallback; confirm triage and suggested replies run.
4. Start the evaluation set: 20–30 closed tickets that have a fix PR, plus a fixture app with seeded bugs.
- **Checkpoint**: ticket → hub → ticket number and status back → agent reply reaches customer.localhost; the C1 and C2 security checks pass; triage runs on Kimi, and with the Kimi key removed it runs on OpenAI.

**Phase 1: The vertical slice (≈ 50 days, built in four steps 1a–1d, each with its own plan)**: questions, diagnosis, bug investigation, PR generation, sandbox testing, human approval. No production deployment yet: a merged PR is deployed by a TBO engineer through Press by hand, as today, and the customer gets "Fix live" when they do.

**Phase 1a: Hub foundation + customer stages (≈ 12 days)**
1. H2: HDS Copilot Settings, HDS Site Registry, `registry.py`, `press.py` reads, `docs/tbo-copilot.md`.
2. H3: HDS Copilot Run/Event, `runs.py` state machine, custom fields, worker API (`claim_job`, `heartbeat`, `post_events`, `submit_result`).
3. C3: Support Ticket schema + UI (stages, updates, Confirm/Reopen, context capture, mic optional, visibility by `raised_by`). C4: `hub_api` + capabilities.
4. H6: `router.py`, `customer.py`, templates, confirm/reopen API + portal banner; the hub switches to `hub_api` when the client advertises it.
- **Checkpoint**: a fake worker script (`bench execute`) calls `claim_job` → `submit_investigation` for each root-cause category; the customer sees "Received → Working on it" on customer.localhost; an explanation appears in the suggested-reply card and the agent sends it; Confirm closes the ticket, Reopen escalates and the stage says "With a person".

**Phase 1b: Hub MCP server, TASK-2026-00013 (≈ 8 days)**
1. H4: MCP endpoint + read tools + HDS Copilot Call Log + rate limit.
2. H5: write tools + worker tools + `customer_erp_read` allow-list.
3. C6: diagnostic tools (`get_code_identity`, `get_customizations`, `get_deploy_status`, extended `get_error_log`, `get_version_history`) + registry gating.
- **Checkpoint**: `npx @modelcontextprotocol/inspector` lists and calls the tools on `tbo.localhost`; the TBO Copilot desktop app connects from **Settings → MCP** (HTTP endpoint + Authorization header) and the AI reads tickets with no plugin; CI green; the TASK-13 PR says `Closes TASK-2026-00013`; the helpdesk maintainer reviews.

**Phase 1c: The worker + sandbox, shadow mode (≈ 22 days)**
1. W0: the VM, arm64 build of host-core and bundles, `llm-proxy` with Kimi → OpenAI fallback (`pi-host` answers "headless OK" through the proxy).
2. W1: `apps/tbo-worker-host` (MCP relay, local tools, stage policy, Unix-socket RACP) + integration test with a stub MCP server.
3. W2: supervisor core (claim/lease/outbox/workspace/context/events) → a trivial job runs end-to-end against the hub.
4. W3: sandbox images, snapshots, sanitizer, evidence runner → a seeded bug: regression test fails on base, passes on fix.
5. W4: GitHub App, push, PR with trailers, onboarding workflow PRs for the pilot repos, hub merge and revert jobs.
6. **Shadow mode**: the worker investigates real tickets read-only and posts its diagnosis as an internal note; the evaluation set is run; results in `docs/tbo-copilot-models.md`.
- **Checkpoint**: a fixture-app bug → PR with an evidence table and a passing AI review; shadow-mode diagnosis agrees with the engineer on most tickets (measured, with cost per ticket).

**Phase 1d: One approval + merge (≈ 8 days)**
1. H7: approvals (payload hash, assignment, senior rule, first wins, supersede, reminders), `copilot_actions.js` dialog, `api/copilot.py`, Teams message with a link.
2. H8: `work_link.py`, `github_sync` changes (`head_sha`, `copilot_run`, merged → "ready to deploy" record), `risk.py`, PR evidence on the card.
- **Checkpoint**: a real ticket on a pilot repo → PR → the card on the ticket page + the Teams message → Approve → the hub squash-merges → the Task completes → "Fix merged" on the ticket; Reject with a note → a follow-up run. **End of Phase 1 = the first useful pilot**: Copilot answers questions, diagnoses, prepares tested PRs; people approve and deploy as today.

**Phase 2: Controlled production deployment (≈ 11 days)**
1. H10 + W5: HDS Deploy Request, Press adapter, verify, rollback via revert, deploy records; confirm the Press API shapes on TBO's Press first.
2. In the pilot the approver or lead presses **Deploy** (`deploy_now`) after reading the sandbox verification; night window recommended; one build at a time; `auto_deploy_categories` stays empty.
3. After several successful deployments (suggested: at least 10 with no rollback), fill `auto_deploy_categories` with low-risk categories so those approved fixes deploy automatically in the night window.
- **Checkpoint**: an approved no-op change deploys to a Press test site when Deploy is pressed and verifies; a deliberately failing migrate is recovered by Press and escalated; the customer gets "Fix live, please confirm" and confirms.

**Phase 3: Config and data changes with senior approval (≈ 8 days)**
1. H9 + W6 + C5: change sets (dry-run on the sandbox copy, approval token, HDS Change Log), "fix the code first, then the data".
2. Approval always by a senior; the hub applies with logging, or the senior applies by hand from the change set; never automatic.
- **Checkpoint**: a data correction is dry-run on the sandbox copy, approved by a senior, applied, and shows in the site's Version history with before/after; a submitted invoice is corrected by cancel and amend, never edited directly.

**Phase 4: Pilot and hardening (≈ 6 days + the pilot period)**
1. Pilot with the first customer: questions and diagnosis first, then low-risk code fixes with controlled deploys, then config/data fixes.
2. W7: limits, load test (3 parallel runs, budget cut-off), runbooks, `docs/tbo/README.md` core list; H11: the Vue card on the ticket page.
3. Weekly: cost per ticket, fix rate, false-PR rate, approval wait time; adjust prompts and the model map.

**Later, not now (§5.6)**: Teams bot with buttons, Entra sign-in and OAuth instead of API keys, Press UAT for customer acceptance, the `/copilot` board, proactive error watch, known-issue memory, deploy train.

## 8. Verification

- **Unit tests per PR**: hub `helpdesk/tests/test_copilot_*.py` (FrappeTestCase with `hold_commits`; helpers in `test_utils.py`: `make_copilot_settings`, `make_copilot_run`, `make_site_registry`, `make_copilot_approval`, `fake_worker_result`, `FakePress`, `FakeClientSite`), covering transitions and locks, lease and idempotent events, router outcomes, approval assignment / senior rule / first wins / supersede / reminders, MCP auth and rate limit, change sets, deploy with `FakePress`; client `helpdesk_client/tests/` (`test_hub_api`, `test_mcp_auth`, `test_write_safety`, `test_hub_role`, `test_diagnostic_tools`, security regressions: a guest cannot…, a non-support user cannot…, GET is refused…); worker `vitest` unit + integration with a stub MCP server and a fake provider.
- **CI**: helpdesk (CodeRabbit, task-reference, server tests, lint, semantic commits), helpdesk_client, tbo-copilot (fork tests + plugin fetch), tbo-copilot-worker (`vitest`, docker build).
- **End-to-end on the local pair** after Phase 5: raise a ticket as a test user on customer.localhost with a recording → HD Ticket, triage, "Received" on the client → the worker (or the fake worker) investigates → for each category: the right message, approval type and artifacts → approve → PR webhook replay (`send_github_webhook` fixture) → Merged → Deploy Request (FakePress locally) → Resolved on the client → Confirm, then Reopen → escalation. Negative cases: lease lost mid-run, worker `fail`, approval superseded by a new push, reject → follow-up, deploy failure → recovery + escalation, customer reopen, double approval click, hub down (worker outbox keeps events).
- **Red team before the pilot**: prompt injection in the ticket text, error logs, the repo's `AGENTS.md`, and the recording transcript; a planted `.env` and symlinks; expect denials, no egress, no secrets in events or PRs, `suspicious_instructions_seen` recorded.
- **Evaluation**: the fixed set re-run on every prompt, model or engine change; track fix rate, false-PR rate, human edits needed, time, cost per completed task.

## 9. Risks and open questions

| Risk | Mitigation |
|---|---|
| Merge conflicts with the helpdesk maintainer's daily work in `helpdesk` | everything in `helpdesk/copilot/` + own doctypes; small PRs cut from that day's `main`; shared files (`hooks.py`, `install.py`, `test_utils.py`) touched once per PR with minimal lines |
| Press API shapes and auth unverified for 0.7.0; no rollback API; one build at a time; builds strain live sites | confirm on TBO's Press before Phase 5; night window only; revert-PR rollback; DB restores manual with backup names on the escalation |
| GitHub Free plan: rulesets not enforced on private repos; some customer apps live in other orgs | the hub enforces `copilot/**` and per-run tokens; direct pushes stay a documented convention; other-org repos are investigate-only until the App is installed there |
| Sanitizer misses a secret (ZATCA keys, tokens) in a customer copy | strip-list reviewed with the helpdesk maintainer; the copy is quarantined until sanitized; no files copied; snapshots expire after 7 days |
| Customer apps have almost no tests | evidence relies on migrate, the agent's regression test (fails on base / passes on fix) and page/report smoke checks; the card says what was not tested |
| Model quality (Kimi) on real tickets; Kimi credit ends | measured in shadow mode before any write; automatic fallback to OpenAI; the model map is a setting |
| Customer emails depend on the hub's outgoing email setup | stage messages still reach the client app and Chatwoot; email is additive |
| `MCPClient` commits after every audit row | acceptable; tests patch `MCPClient` |
| Worker VM cost and single point of failure | one VM for the pilot; the hub re-queues on lost leases; a second VM later |

Open questions: which project holds Copilot tasks per customer; who is in the first approver rota and who is senior; message languages (English now; Arabic/Malayalam later); may Urgent tickets deploy outside the window; the exact Press API responses; whether to upgrade GitHub to Pro for private-repo rulesets.

## 10. How we work: one phase at a time

1. **Before each phase** (and each step 1a–1d): write that phase's architecture and plan as `phases/phase-<n>.md` (what changes, files, doctypes, APIs, tests, the checkpoint, risks) → the owner approves → build in small PRs → test on the local pair → report the checkpoint → update the status in `build-plan.md` and in memory.
2. **Nothing is pushed or merged without the owner's go-ahead** (existing rule), and each repo's own rules apply (helpdesk: AGENTS.md, task reference, CodeRabbit; tbo-copilot: worktree per task, no `git add .`). **In `helpdesk` and `helpdesk_client`, Copilot work is pushed to the `tbo-copilot` branch; nothing is pushed to `main`, no pull request goes to `main`, and a branch already on GitHub is never rewritten** (owner, 9 Oct 2026). A newer `main` is merged into `tbo-copilot` and the module tests are run again before the push. **In `tbocloud/tbo-copilot`, documents and code go to `tbo` (the default branch) through a pull request (the branch rules ask for one approval and the `ai-review` and `task-reference` checks); `main` there is the copy of upstream PI-Desktop and is never touched.** The repository is public, so only a cleaned copy of these documents goes there. A pull request, if one is wanted, targets `tbo-copilot` and is opened as a draft, because helpdesk's auto-merge workflow switches auto-merge on for every non-draft pull request whatever its base.
3. **Each phase ends with a demo on the local pair** (`tbo.localhost` ↔ `customer.localhost`), and no phase starts before the previous checkpoint passes.
4. **First actions after this plan is approved**: save the memory files (§11), store the design documents (§11), then write `phases/phase-0.md` for approval.

## 11. Where everything is stored, so nothing is lost between conversations

**Design documents** (the source of truth):
- `tbocloud/tbo-copilot` → `docs/tbo/`: `architecture.md` (the agreed principles; updated with the 8 Oct decisions), `system-design.md` (§1–§6 of this plan), `build-plan.md` (§7–§10 with a status per phase: Not started / Plan written / Approved / In progress / Done), `phases/phase-0.md`, `phase-1a.md` … (one per phase, written before each phase). These go in through PRs (`Refs TASK-2026-00010` until a task for the build exists).
- A mirror in the owner's private planning folder (same files), written immediately, so they are usable before the PRs are merged. The older files there (`system-flow.md`, `plan-b-pi-desktop-fork.md`, `tbo-copilot-architecture.md`) get a "superseded by design/" banner.
- `tbocloud/helpdesk` → `docs/tbo-copilot.md` (the hub spec, kept current in every Copilot PR as AGENTS.md requires), created in PR H2.
- `tbocloud/tbo-copilot-worker` → its own `docs/` (worker, sandbox, GitHub, Press runbooks), created with the repo in Phase 1c.

**Working notes** (kept outside the repository), updated at the end of every work session:
- `tbo-copilot-status.md` (project): the current phase and step, what is done, what is in progress, the next action, open decisions, links to the PRs and the local pair details.
- `feedback-phase-approval-process.md` (feedback): per-phase plan → owner approval → build; nothing pushed without a go-ahead.
- `feedback-controlled-deploy-pilot.md` (feedback): controlled deploy and senior-only data fixes in the pilot; automatic deploy only for low-risk categories after proven tickets; §5.6 features later.
- `reference-tbo-copilot-docs.md` (reference): where every document, repo, branch, worktree and local site lives.
- Existing: `test-locally-before-push.md`.
A new conversation starts by reading `MEMORY.md`, then `tbo-copilot-status.md`, then the current phase document.
