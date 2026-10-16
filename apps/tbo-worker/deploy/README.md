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
| `TBO_MODEL_BASE_URL`, `TBO_MODEL_ID` | The model, for example `https://api.openai.com/v1` and `gpt-5.6-luna` |
| `TBO_MODEL_API_KEY` | The worker's own AI key (an OpenAI project key with a monthly limit) |
| `TBO_MODEL_PRICE_IN`, `TBO_MODEL_PRICE_OUT`, `TBO_MODEL_PRICE_CACHED` | Dollars per million tokens, for the per-run budget |

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
