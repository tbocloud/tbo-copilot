# Running the Copilot worker server

For whoever looks after TBO Copilot during the pilot. How to install and update the worker is in
`apps/tbo-worker/deploy/README.md`; the sandbox runner in `apps/tbo-sandbox/README.md`. TBO Support's side
(levels, budget, approvals, deploys, corrections) is in the `helpdesk` repository's `docs/tbo-copilot.md`.

## What runs where

| Part | Where | What it does |
|---|---|---|
| The worker | Worker server, Docker container `tbo-worker` (restarts by itself) | Claims runs from TBO Support, investigates, writes fixes, opens pull requests |
| The sandbox relay | Worker server, systemd service `tbo-sandbox-relay` | Starts the fix server when a fix needs it and passes the worker's sandbox requests to it |
| The sandbox runner | Fix server | Builds a throwaway copy of the customer's site per fix and runs the checks; the server powers off after 20 idle minutes |
| The settings file | Worker server, `/var/lib/tbo-worker/env` (mode 600) | TBO Support's address and the worker's key, the AI providers' keys, the GitHub token |

TBO Support decides which customers Copilot works for and how far (the Copilot level), which model each job uses
(Settings → AI providers → Models per job), the monthly AI budget and the per-run caps. The worker only holds
addresses and keys.

## Every day

- **TBO Support → Copilot Pilot** report: diagnoses, ratings, fixes, corrections, waits and cost. The same numbers
  arrive by email on Monday morning.
- **Alerts** reach the Agent Managers in TBO Support and the team's channel: the AI budget at 80% and 100%, runs
  waiting with no worker, an AI provider failing, an approval waiting too long.
- On the worker server, when something looks wrong:

```
docker ps --filter name=tbo-worker          # running, and since when
docker logs --since 1h tbo-worker           # the last hour: claims, runs, failures
docker run --rm -v /var/lib/tbo-worker:/data tbo-worker check
sudo systemctl status tbo-sandbox-relay
df -h / && docker system df                 # disk
```

## Keys

Keys are typed on the server only, never in chat, Git or a ticket. To change one: edit the settings file
(`sudo nano /var/lib/tbo-worker/env`), then `docker restart tbo-worker` and run `check`. The OpenAI and Moonshot
keys are separate project keys with a monthly limit at the provider; TBO Support's own AI keys are set in its
Settings → AI providers and are not the worker's.

## Disk

Old images: `docker image prune -f` on both servers, once a month or when `df -h` shows less than 20% free. Never
prune containers on the worker server: a stopped `tbo-worker` would be deleted with them (if that happens, create it
again with the run command in `apps/tbo-worker/deploy/README.md`). The sandbox runner removes each throwaway site after its fix, and
when a new one starts it removes any left over for more than a day.

## Incidents

### Stop Copilot at once

TBO Support → HDS Copilot Settings → **Copilot enabled** off. No run starts, no worker gets work, and a worker
in the middle of a run is told to stop within 30 seconds; its ticket goes back to the team. Switching it on again
starts nothing by itself: start a run from the ticket's Copilot button.

### The AI provider is down or out of credit

Signs: runs fail with "the model failed (PROVIDER_RATE_LIMITED)" or "(PROVIDER_UNAUTHORIZED)"; a `fallback` event
on runs that moved to the other model; TBO Support's banner for its own AI features.

1. Each stage restarts once on the fallback model by itself. When both fail, the run fails and the team has the
   ticket.
2. Top up the account, or replace the key: the worker's in its settings file (then `docker restart tbo-worker`),
   TBO Support's in Settings → AI providers (then **Test connection**).
3. Start the failed runs again from each ticket's Copilot button.

### Runs wait and no worker takes them

Signs: the alert "Copilot runs have waited more than 15 minutes with no worker claiming them".

1. Is the monthly AI budget used up? Then TBO Support sent its own alert: raise the budget in HDS Copilot
   Settings → Pilot, or wait for the next month.
2. `docker ps`: the container is not running → `docker start tbo-worker`, then read `docker logs`.
3. Running but not claiming → `docker logs --since 30m tbo-worker`: a rejected key (TBO Support's worker user),
   or TBO Support unreachable. `check` names the failing part.
4. The server itself is down (no SSH, the alarm says so) → start it from the AWS console (DevOps). Runs that were
   in progress go back to the queue when their lease ends and are picked up again.

### A fix that should not have been merged

1. On the ticket's Copilot card: **Undo the fix**. Copilot opens the revert, one person approves it, and it is
   deployed like any fix.
2. Rate the diagnosis **Wrong** with the right root cause, so the weekly numbers and the next prompt change see it.
3. Tell the customer what happened, from the ticket.

### A correction that went wrong

TBO Support's `docs/tbo-copilot.md`, "When a correction goes wrong": **Undo the change** prepares the reverse,
a senior approves it.

### A deploy that failed

TBO Support's `docs/tbo-copilot.md`, "Deploying through Press": Press rolls the site back itself; the card links
the deploy and the backup.

### The fix server does not start

`sudo journalctl -u tbo-sandbox-relay --since "1 hour ago"` on the worker server: the relay starts the fix server
through its instance role. When the start is refused, DevOps checks the role; until then fixes fail and
investigations go on.
