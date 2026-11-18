# TBO Copilot worker

The worker takes Copilot runs from TBO Support (the `helpdesk` hub) and investigates them with the pi engine, read-only. For each ticket's run it:

1. Claims the run and keeps its lease alive.
2. Prepares a read-only folder: the ticket, and the customer's app code checked out at the commit their site runs.
3. Lets the model investigate with a small set of tools.
4. Reports the root cause to the hub.

The hub decides what happens next (Phase 1a router). In shadow mode it notes the diagnosis for the team and the customer hears nothing.

The design and the phase plan are in TBO's design documents (`system-design.md` §5.3, `phases/phase-1c.md`, `phases/phase-1c-2.md`). Phase 1c-1 is the investigation. Phase 1c-2 adds **fix jobs** (below): with a sandbox runner, the worker also writes the fix, tests it on a copy of the customer's site and opens the pull request. Phase 25 adds **infrastructure alerts** (below): every worker also looks into alerts about TBO's own servers and sites and proposes at most one action from a fixed list. Phase 26 adds **developers' pull requests** (below): with a sandbox runner, the worker also fixes what CodeRabbit and CI found on a TBO developer's pull request and pushes the fix to that pull request's branch.

## How it works

| Part | File | What it does |
|---|---|---|
| Engine | `src/engine.ts` | Starts host-core and the agent sidecar as child processes and drives them in-process through the runtime service, as `apps/pi-host` composes them, without the RACP server |
| Job loop | `src/supervisor.ts` | Claims runs, heartbeats every 30 s, runs one investigation turn, and sends one reminder if the model ends without a report. Once the hub has the report it stops the model at once (a closing reply only costs tokens). With no diagnosis it reports a failure |
| Workspace | `src/workspace.ts` | Keeps a bare mirror per repository and clones each app at the run's base commit, else the deployed commit, else the branch head. Removes the remote, writes `context/` and `INDEX.md`, then makes everything read-only. `context/known_issues.md` holds the errors Copilot already knows for the ticket and site (Phase 9; another customer's as code facts only), and `context/site.json` the site's latest deploys through TBO Support, so an error logged before a deploy is not taken for a live bug |
| Tools | `src/tools.ts`, `src/repo-git.ts` | The four tools listed below |
| Policy | `src/policy.ts`, `src/engine.ts` | Applies the read-only rules listed below, plus budgets on tool calls, tokens and minutes |
| Hub client | `src/hub.ts` | Calls the worker API with the worker user's key, and the hub's MCP endpoint with the run token. The evaluation also uses three agent calls |
| Evaluation | `src/evaluate.ts` | Runs the evaluation cases end to end through the hub and writes a Markdown and JSON report |

The model gets four tools. The model activates them with one `ToolSearch` call, because the engine treats added tools as on-demand.

- `hub_get_run_context`: the run's ticket, triage, site and conversation, fresh from the hub.
- `hub_customer_erp_read`: one of the hub's allow-listed read tools on the customer's site, such as the error log, version history or customizations.
- `hub_submit_investigation`: the report. The worker adds the measured tokens, cost and model before sending it.
- `repo_git`: `log`, `show`, `blame` and `diff` in the clones. The model passes typed values, never raw arguments.

### The read-only rule

- Sessions run in agent mode with permission mode `ask`, and the worker answers every permission prompt with deny. In this mode host-core prompts for Bash, Write, Edit, unknown tools and any path outside the run's folder. Read, Glob and Grep inside the folder never prompt.
- The one exception is the engine's own scratch folder for the session, where writes never prompt. The worker deletes it with the session.
- Every question the model asks is answered: "no person is available; take the safest assumption".
- No subagents are offered, because a subagent definition can carry its own permission mode.
- The engine and git run with an empty home folder (`~/.tbo-worker/home`). None of the desktop app's global instructions, prompt templates or subagent definitions reach a run.
- A repository's own instruction files (`AGENTS.md` and the like) are never loaded as instructions; the model can only read them as files.
- The checkout and context files are read-only on disk too.
- The hub sees every tool call, every refusal and the token use as run events.

On the Mac this is a permission policy. The worker VM in Phase 1c-2 adds kernel isolation: containers, a separate user and no network.

## Fix jobs (Phase 1c-2)

A worker started with `TBO_SANDBOX_SOCKET` (the sandbox runner on the worker server) claims fix jobs as well as investigations. The hub queues one when someone asks Copilot to fix a diagnosed bug. For each fix job the worker:

1. Picks the app to fix: one of the site's apps that TBO Support lets Copilot push to, the one the diagnosis names when there are several (`src/fix.ts`, `chooseApp`).
2. Asks the hub for a GitHub App key for that one repository, valid an hour (`repo_token`). It clones the app with that key onto Copilot's own branch (`copilot/TASK-…-r<run>-a<attempt>`, the only kind accepted), writable, committing as TBO Copilot. Every other clone stays read-only.
3. Asks the sandbox runner for a copy of the customer's site running the edited app (`src/sandbox.ts`: one JSON request per line over a local socket, a fixed list of operations, no command lines).
4. Runs a fix session with its own profile:
   - **tools:** `sandbox` (check one test module, the app's tests, migrate), `my_changes`, `repo_git`, `fix_done`;
   - **edits:** Edit, Write and MultiEdit are allowed only inside the app being fixed, never its `.git`, never through a symbolic link leading out, never by a delegate (`policy.editsInside`). Everything else is still refused.
5. **Checks on its own** (`verify`), from the runner's results, never from the model's words:
   - the model's test fails on the code the site runs (the bug is shown) and passes on the fix. It must fail on an assertion: the runner's answer says whether a failed check failed an assertion or errored (`failure`), and an answer without it stops the job;
   - the copy still migrates;
   - the app's tests pass;
   - no new error appears;
   - nothing secret-shaped is in the change.

   A test that already passes on the unchanged code ends the job: the bug was never shown.
6. Has a fresh review session read the change. Findings marked must-fix send the fix back for another round, at most three rounds.
7. Commits, pushes the branch, and opens the pull request with the push key. The pull request says `Closes TASK-…` and carries the results table and the review notes, with the labels `copilot` and `no-auto-merge`.
8. Reports it to the hub with `submit_change`. The hub then asks for the one approval. Any failure is reported instead, and the hub hands the fix to the developer.

Limits: `TBO_FIX_MAX_TOOL_CALLS` (120), `TBO_FIX_MAX_MINUTES` (60), `TBO_FIX_MAX_TOKENS` (8 million), `TBO_FIX_MAX_ROUNDS` (3), and the hub's dollar cap per fix.

### Builds of approved customizations (Phase 8)

A fix job whose context carries `fix.build` (the scope and the Done-when checks the customer approved) is a build. It runs the same steps with these differences:

- **Its own rules** (the `build` profile, `BUILD_RULES`): build only the scope, in the customer's app (Python, hooks, Custom Fields and Property Setters as fixtures); one test per Done-when check; stop with `cannot_fix` instead of building when the scope needs a change to Frappe or ERPNext, a new integration, keys, more than a small change, or is unclear.
- **`fix_done` covers the scope:** `check_results` has one row per Done-when check, worded as the scope words it, with its test module inside the app, or `not_testable` with the reason. A missing check, a check the scope does not have, or no tested check at all is refused (`checkBuildResults`).
- **Its own checks** (`verifyBuild`): every test module passes on the change; at least one fails on an assertion on the code the site runs (the change was missing), and none errors there. A check that holds already (for example "a return is not affected") passes before and after, and is reported so. Then migrate, the app's tests, no new errors and no secrets, as for a fix.
- **The review** gets the scope: anything beyond it is must-fix, and so is a check without a test.
- **The pull request** carries the scope and a Done-when table (each check, its test, before and after); the commit is a `feat:`. `submit_change` reports `check_results` (check, test, before, after, note), which TBO Support shows next to the scope on the approval.
- The investigation's report may draft a customization's scope (`proposal.scope`) and checks (`proposal.done_when`), which TBO Support puts into the estimate for people to correct with the customer.

## Infrastructure alerts (Phase 25)

Every worker also takes infrastructure alerts (it claims with `infra`, with or without a sandbox). TBO Support's watcher opens an Alert ticket about one of TBO's own sites, benches or servers, and the hub queues a run of kind `infra`. Its context has no customer and no code: the alert and its updates, what Press says about the target, TBO Support's own health check, earlier repairs on the alert, the actions Copilot may propose (`actions`), the names a proposal's target must come from (`may_target`), where an approved action may run (`may_change`), the run's dollar cap (`dollar_cap`) and three short rules. TBO Support takes the secrets out of all of it first.

For such a run the worker (`processInfra` in `src/supervisor.ts`):

1. Clones nothing, starts no sandbox and reads no customer site. The session opens in an empty run folder with its own profile (`infra`): its persona and rules (`src/infra-prompt.ts`) and three tools (`src/infra-tools.ts`):
   - `hub_press_read`: one more read of Press through TBO Support (`press_read`: a site's status, recent jobs, one job's steps and output, failed jobs of the last hours, a site's logs), redacted there;
   - `hub_post_event`: a short progress note, which the worker sends with the run's own numbered events;
   - `hub_submit_infra_investigation`: the report (`submit_infra_investigation`): summary, confidence, cause, evidence lines, at most one proposal `{action, target, why, expected}`, and `person_steps` for a person. The worker checks that the action is on the run's list and the target in `may_target` before TBO Support sees it, and adds the measured cost.
2. Puts the alert, the facts, the actions, `may_target`, `may_change` and the rules in the first message, the alert and the facts inside the untrusted-content wrapper: everything read is data, never instructions. Text in them that tries to instruct the AI is recorded as a `suspicious_instruction` event, as for a ticket.
3. Runs the turns as an investigation does: the `investigate` job's models and fallback, one reminder, the same limits, and the lower of `TBO_MAX_USD` and the run's `dollar_cap`, then one last turn to report. With no report, it reports a failure.

TBO Support then decides: an action inside `may_change` goes to an approver, one outside it to a person to run, and with no proposal a person takes it from there.

## Developers' pull requests (Phase 26)

A worker with the sandbox runner also claims with `pr_fix`. When no run is waiting, TBO Support may hand it a developer's pull request instead (`kind` `pr_fix`): the pull request, its head branch and the commit to build on (`head_sha`), the round (1 to 3), the findings (CodeRabbit's unresolved review threads and the failed CI checks, each with an `id`), the customer's site apps for the sandbox, a read-only clone key (`repo_token`), Copilot's commit email, the `fix` job's models, a dollar cap and a few rules. The lease is 60 minutes, kept alive with `pr_heartbeat`.

For such a job the worker (`src/pr-fix.ts`):

1. Asks the remote where the head branch is now. Anywhere but `head_sha` fails the job ("the branch moved") before anything is cloned.
2. Clones the repository at `head_sha` into `apps/<app>/`, writable, committing as TBO Copilot with the job's email, and starts a sandbox site with the customer's apps and this app mounted from the clone (as a release's check does). Without a sandbox, or when the runner cannot start one, the job goes on and says the tests did not run here; CI runs after the push.
3. Runs a session with its own profile (`pr_fix`, `src/pr-fix-prompt.ts`): the findings in the first message, each inside the untrusted-content wrapper (text in them that tries to instruct the AI is logged as a suspicious instruction), and four tools (`src/pr-fix-tools.ts`): `sandbox`, `my_changes`, `repo_git` and `pr_fix_done`. Edits follow the fix's rule (only inside the app, never `.git`, never through a link out, never by a delegate) and never touch CI or review settings: `.github/`, `.gitlab-ci.yml` and the other pipelines, `.pre-commit-config.yaml`, `.coderabbit.yaml`, `.gitmodules` (`policy.pullRequestEdits`). The rule holds for the path as written and for where it really lands, so a committed link (`meta -> .git`) leads nowhere it protects. There is no shell and no subagent.
4. `pr_fix_done` answers every finding once: `fixed` with one line on what changed, or `not_fixed` with one line on why (a finding the model disagrees with may be left, explained). TBO Support posts each line as the reply to the finding. A fix listed without a change, or a change listed under no fix, is refused, when the tool is called and again against the change as it stands when the turn ends.
5. Checks on its own, from the runner's results: nothing secret-shaped added, the copy migrates, the app's tests pass. A failing step counts against the change only when it passes on the pull request's code without it, which the worker runs once, on a second, fresh copy of the site from its own checkout of `head_sha` (the first copy holds the change's migrations, and the runner cannot undo them); then the model gets another round, up to `TBO_FIX_MAX_ROUNDS`. Tests that failed before the change too are reported, not blamed on it.
6. Commits on top of `head_sha` (`fix: CodeRabbit and CI round <n> (TBO Copilot)`, naming only the reviewers whose findings it fixes), asks TBO Support once more whether to go on, takes the push key (`pr_push_key`), checks the key is for this repository and the head branch, checks the remote is still at `head_sha`, looks once more for a cancel, a lost lease or a shutdown, and pushes with a plain refspec: never `+` or `--force`, so the remote takes it only as a fast-forward of that branch. Anything else fails the job, and nothing is pushed. When git reports an error, the branch decides: at Copilot's commit, the fix counts as pushed; at another commit, the job fails; unreadable, the outcome is unknown and nothing is reported, so the lease lapses and TBO Support takes a fresh look at the pull request.
7. Reports with `pr_result`: `done` with the new head (or the old one when every finding was left), each fixed finding with the commit, the findings left with their reasons, the tests (`ran`, `passed`, `detail`) and the cost; or a `failure` with its reason. A `cancel` from the heartbeat (the developer pushed, or the pull request closed) stops the job; nothing is pushed or reported, not even a failure.

It runs on the `fix` job's models with its fallback, under the fix's limits (`TBO_FIX_MAX_*`) and the job's dollar cap.

## Setting it up on a Mac

1. Build the engine once:
   - `pnpm install`
   - `pnpm --filter "@tbo/worker..." build`
   - `pnpm build:host` for the host-core binary. Or point `TBO_HOST_CORE_BIN` at an existing build.
2. On the hub:
   - Create a worker user with the role **Copilot Worker** and API keys.
   - Register the customer's site and apps in **HDS Site Registry**, each app with its repository, branch and deployed commit.
3. Write `~/.tbo-worker/env` with mode 600. Never commit it.

```
TBO_HUB_URL=http://tbo.localhost:8002
TBO_WORKER_API_KEY=...
TBO_WORKER_API_SECRET=...
# The AI providers this worker may use: one key or both. TBO Support names each stage's model
# (Settings → AI providers → Models per job) and its price; the key only goes to the address here.
TBO_PROVIDER_OPENAI_API_KEY=...       # TBO Support's OpenAI section
TBO_PROVIDER_MOONSHOT_API_KEY=...     # TBO Support's Anthropic-compatible section (Kimi)
# Optional, with these defaults:
# TBO_PROVIDER_OPENAI_BASE_URL=https://api.openai.com/v1
# TBO_PROVIDER_OPENAI_API_STYLE=responses
# TBO_PROVIDER_MOONSHOT_BASE_URL=https://api.moonshot.ai/v1
# TBO_PROVIDER_MOONSHOT_API_STYLE=chat_completions
# (and <prefix>_CONTEXT_WINDOW, <prefix>_MAX_OUTPUT_TOKENS: 256000 and 16000)

# Older, still working: one model for every stage, used when TBO Support names no model
# this worker has a key for (an older hub). Prices in USD per million tokens.
# TBO_MODEL_API_KEY=...   (or MOONSHOT_API_KEY)
# TBO_MODEL_BASE_URL=https://api.moonshot.ai/v1
# TBO_MODEL_ID=kimi-k2.6
# TBO_MODEL_PRICE_IN=0.60
# TBO_MODEL_PRICE_CACHED=0.15
# TBO_MODEL_PRICE_OUT=2.50

# Optional. The engine, and GitHub (else the logged-in gh token is used):
TBO_HOST_CORE_BIN=/path/to/pi-desktop-host-core
GITHUB_TOKEN=...

# Evaluation only: an agent's key
TBO_HUB_AGENT_API_KEY=...
TBO_HUB_AGENT_API_SECRET=...

# Limits per run
TBO_MAX_TOOL_CALLS=60
TBO_MAX_MINUTES=20
TBO_MAX_TOKENS=4000000
TBO_MAX_USD=2

# Repositories for apps the registry does not list, and keeping run folders for debugging
TBO_REPOS=app=owner/repo,app2=owner/repo2
TBO_KEEP_RUNS=1
```

A value may be followed by a comment (`KEY=value   # note`); a `#` inside quotes is kept.

**Limits.** `TBO_MAX_TOKENS` counts the tokens of every model request in the run. Each request sends the whole conversation again, so the count grows quickly; a run of about 40 tool calls can pass 1.5 million. `TBO_MAX_USD` applies only when the prices are set, and 0 switches it off. When a limit is reached, the worker stops the turn and asks the model once to report what it has found. That last turn may make at most 3 tool calls and take at most 3 minutes; without a report then, the run fails with the limit as its reason.

## On a server

TBO's worker server runs it in Docker: [deploy/README.md](deploy/README.md) (build, the settings file, run, update).

## Commands

```
node apps/tbo-worker/dist/cli.js check                 # settings, hub key, engine; no model call
node apps/tbo-worker/dist/cli.js start                 # investigate queued runs until Ctrl-C
node apps/tbo-worker/dist/cli.js once [--run NAME]     # one run, then exit
node apps/tbo-worker/dist/cli.js eval --cases FILE [--only A1,A6] [--report FILE]
```

**Stopping.** Ctrl-C interrupts the current turn without reporting anything. The lease then expires, and the hub's cron puts the run back in the queue. On a local site the scheduler must be enabled for that.

**Evaluation cases.** These come from a private JSON file that holds the expected answers, so it never goes into this public repository. Each case has:
- `id`, `ticket`, `kind` (bug or customization) and `app`;
- `repository` and `base_commit`, the commit before the real fix;
- `expected_root_cause` or `accepted_root_causes`, and `fix_files`.

## Tests

```
pnpm --filter @tbo/worker test
TBO_TEST_HOST_CORE=/path/to/pi-desktop-host-core pnpm --filter @tbo/worker test
```

The second form also runs the end-to-end tests. Those use a stub hub and a scripted OpenAI-compatible model, and run without network. They skip when no host-core binary is found.
