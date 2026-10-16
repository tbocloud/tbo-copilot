# TBO Copilot worker

The worker takes Copilot runs from TBO Support (the `helpdesk` hub) and investigates them with the pi engine, read-only. For each run it:

1. Claims the run and keeps its lease alive.
2. Prepares a read-only folder: the ticket, and the customer's app code checked out at the commit their site runs.
3. Lets the model investigate with a small set of tools.
4. Reports the root cause to the hub.

The hub decides what happens next (Phase 1a router). In shadow mode it notes the diagnosis for the team and the customer hears nothing.

The design and the phase plan are in TBO's design documents (`system-design.md` §5.3, `phases/phase-1c.md`, `phases/phase-1c-2.md`). Phase 1c-1 is the investigation. Phase 1c-2 adds **fix jobs** (below): with a sandbox runner, the worker also writes the fix, tests it on a copy of the customer's site and opens the pull request.

## How it works

| Part | File | What it does |
|---|---|---|
| Engine | `src/engine.ts` | Starts host-core and the agent sidecar as child processes and drives them in-process through the runtime service, as `apps/pi-host` composes them, without the RACP server |
| Job loop | `src/supervisor.ts` | Claims runs, heartbeats every 30 s, runs one investigation turn, and sends one reminder if the model ends without a report. Once the hub has the report it stops the model at once (a closing reply only costs tokens). With no diagnosis it reports a failure |
| Workspace | `src/workspace.ts` | Keeps a bare mirror per repository and clones each app at the run's base commit, else the deployed commit, else the branch head. Removes the remote, writes `context/` and `INDEX.md`, then makes everything read-only |
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
MOONSHOT_API_KEY=...

# Optional. The model:
TBO_MODEL_BASE_URL=https://api.moonshot.ai/v1
TBO_MODEL_ID=kimi-k2.6
# USD per million tokens, for each run's cost; cached input is input the provider served from its cache:
TBO_MODEL_PRICE_IN=0.60
TBO_MODEL_PRICE_CACHED=0.15
TBO_MODEL_PRICE_OUT=2.50

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
