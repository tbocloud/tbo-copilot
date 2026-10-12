# TBO Copilot worker

The worker takes Copilot runs from TBO Support (the `helpdesk` hub) and investigates them with the pi engine, read-only. For each run it:

1. Claims the run and keeps its lease alive.
2. Prepares a read-only folder: the ticket, and the customer's app code checked out at the commit their site runs.
3. Lets the model investigate with a small set of tools.
4. Reports the root cause to the hub.

The hub decides what happens next (Phase 1a router). In shadow mode it notes the diagnosis for the team and the customer hears nothing.

The design and the phase plan are in TBO's design documents (`system-design.md` §5.3, `phases/phase-1c.md`). This app is Phase 1c-1: investigation only. The sandbox copy of the customer site and pull requests come in 1c-2.

## How it works

| Part | File | What it does |
|---|---|---|
| Engine | `src/engine.ts` | Starts host-core and the agent sidecar as child processes and drives them in-process through the runtime service, as `apps/pi-host` composes them, without the RACP server |
| Job loop | `src/supervisor.ts` | Claims runs, heartbeats every 30 s, runs one investigation turn, and sends one reminder if the model ends without a report. With no diagnosis it reports a failure |
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
# optional
TBO_MODEL_BASE_URL=https://api.moonshot.ai/v1
TBO_MODEL_ID=kimi-k2.6
TBO_MODEL_PRICE_IN=0.60          # USD per million tokens, for the run's cost
TBO_MODEL_PRICE_OUT=2.50
TBO_HOST_CORE_BIN=/path/to/pi-desktop-host-core
GITHUB_TOKEN=...                 # else the logged-in gh token is used
TBO_HUB_AGENT_API_KEY=...        # eval only: an agent's key
TBO_HUB_AGENT_API_SECRET=...
TBO_MAX_TOOL_CALLS=60
TBO_MAX_MINUTES=20
TBO_MAX_TOKENS=600000
TBO_REPOS=app=owner/repo,...     # repositories for apps the registry does not list
TBO_KEEP_RUNS=1                  # keep run folders for debugging
```

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
