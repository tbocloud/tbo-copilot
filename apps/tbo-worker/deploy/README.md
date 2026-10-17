# The TBO Copilot worker on a server

The worker runs in Docker on TBO's worker server (`tbocloud-infra`, `copilot_worker.tf`: a small always-on arm64
Ubuntu box that `scripts/copilot-worker/setup.sh` gave Docker). One image holds the engine (`host-core`, built from
`crates/host-core`) and the worker (`apps/tbo-worker` with the workspace packages it uses); nothing else is installed
on the server.

## Build (on the server, about 20 minutes the first time)

```
git clone --branch tbo https://github.com/tbocloud/tbo-copilot.git ~/tbo-copilot
cd ~/tbo-copilot
docker build -f apps/tbo-worker/deploy/Dockerfile -t tbo-worker .
```

## The settings file

`/var/lib/tbo-worker/env`, owned by the container's user (uid 1000) and readable by it only:

```
sudo install -d -o 1000 -g 1000 -m 700 /var/lib/tbo-worker
sudo install -o 1000 -g 1000 -m 600 /dev/null /var/lib/tbo-worker/env
sudo nano /var/lib/tbo-worker/env
```

| Setting | What |
|---|---|
| `TBO_HUB_URL` | TBO Support's address, for example `https://demo-tbo.tbocloud.in` |
| `TBO_WORKER_API_KEY`, `TBO_WORKER_API_SECRET` | The API key of TBO Support's worker user (role Copilot Worker) |
| `TBO_WORKER_ID` | A name for this worker, for example `aws-worker-1` |
| `TBO_PROVIDER_OPENAI_API_KEY` | The worker's own OpenAI key (a project key with a monthly limit), for TBO Support's OpenAI section. Its API style defaults to `responses`: through Chat Completions, OpenAI's GPT-5.6 models refuse tools together with reasoning (found on the first run, 16 Oct 2026) |
| `TBO_PROVIDER_MOONSHOT_API_KEY` | The Moonshot (Kimi) key, for TBO Support's Anthropic-compatible section; leave it out until Moonshot is topped up |
| `TBO_PROVIDER_<OPENAI or MOONSHOT>_BASE_URL`, `_API_STYLE` | Only to change the defaults (`https://api.openai.com/v1`, `https://api.moonshot.ai/v1`) |

Each stage (investigate, fix, review) takes its model and prices from TBO Support (Settings → AI providers, Models per
job), main first; on a key, billing, wrong-model, server, network or timeout failure it restarts once on the other
section's model, in a fresh session. The older `TBO_MODEL_*` settings (one model for every stage, with its
`TBO_MODEL_PRICE_*`) still work, and are used when TBO Support names no model this worker has a key for: keep them
until the hub has TASK-2026-00012.

Every other setting has a default (`apps/tbo-worker/src/config.ts`). Keys are typed on the server only: never in
chat, Git or this folder.

## Run

```
docker run --rm -v /var/lib/tbo-worker:/data tbo-worker check
docker run -d --name tbo-worker --restart unless-stopped --network host \
  -v /var/lib/tbo-worker:/data tbo-worker
docker logs -f tbo-worker
```

- `check` reads the settings, signs in to TBO Support and starts the engine, without calling the model.
- `--network host`: the worker's instance role (it may start the fix server) is reached through the metadata
  service, which allows one network hop only, and the fix server reaches the worker's AI proxy on its own address.
- Docker restarts the worker after a crash or a reboot. A run in progress when it stops is handed back by TBO
  Support when its lease ends, and another claim picks it up.

## Update

```
cd ~/tbo-copilot && git pull
docker build -f apps/tbo-worker/deploy/Dockerfile -t tbo-worker .
docker rm -f tbo-worker
docker run -d --name tbo-worker --restart unless-stopped --network host \
  -v /var/lib/tbo-worker:/data tbo-worker
```

## Stop

`docker rm -f tbo-worker`. TBO Support re-queues the run it held when the lease ends (5 minutes).
