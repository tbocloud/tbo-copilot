# TBO Copilot sandbox: test a fix on a copy of the site

When Copilot fixes a bug, it shows the bug with a test that fails on the code the site runs, changes the code until
the test passes, and checks that the site still migrates and logs no new errors. All of that runs here: on throwaway
Frappe sites in Docker, never on a customer's live site.

```
WORKER SERVER (always on)                          FIX SERVER (on only during fixes)
tbo-worker container ──TBO_SANDBOX_SOCKET──► relay.py ──ssh (forced command)──► runner.py ──docker──► sandbox site
  (the AI, apps/tbo-worker)                     │ starts the fix server                                MariaDB · Redis · bench
                                                │ (EC2 StartInstances, the worker's one permission)    internal network: no internet
                                                └ sends the app's edited code when it changed
```

| File | Where | What |
|---|---|---|
| `relay.py` | worker server, systemd `tbo-sandbox-relay` (user ubuntu) | Holds `/var/lib/tbo-worker/sandbox/runner.sock` (the worker's `/data/sandbox/runner.sock`); starts the fix server; passes each request over SSH; pings once a minute while a sandbox is open, so the fix server stays on |
| `runner.py` | fix server, `/usr/local/lib/tbo-sandbox` | The only thing the relay's key may run (`restrict,command=…` in `authorized_keys`). One JSON request in, one JSON reply out. Operations: `ping`, `start`, `migrate`, `check`, `tests`, `errors_since`, `try_change_set`, `stop` |
| `site/Dockerfile` | fix server | The sandbox bench: the official `frappe/erpnext` image (`/etc/tbo-sandbox.json`, `erpnext_image`) plus the customer's apps at the commits the site runs |
| `site/tbo_sandbox_site.py` | inside the bench | Error signatures since a time, and the dry run of a correction (each record saved with the site's own code, then rolled back) |

## How a sandbox is made

1. **The image:** one per set of apps and commits (`tbo-sandbox:<key>`), built once and kept. The app being fixed comes
   from the worker's clone; the other custom apps are cloned at the site's commits (an app that cannot be fetched is
   left out, and the start says so).
2. **The snapshot:** a fresh site (`sandbox.localhost`) with every app installed and `allow_tests`, `mute_emails`,
   `pause_scheduler` and `developer_mode` set, stopped and kept under `snapshots/<key>`.
3. **Each fix:** a reflink copy of the snapshot (seconds, on the XFS volume), its own internal network, and the
   app's edited code mounted over the image's copy. `stop` removes all of it.

A first start for a new set of apps takes about half an hour (the image and the snapshot); the next ones take under a
minute. Copies of a customer's own data (a cleaned backup) come later: until then a fix is tested on a fresh site
with the customer's apps, and the pull request says so.

## Tests and results

- `check` runs one test module (the AI's reproduction) and `tests` the app's own tests, both with a JUnit report: a
  failed run is classified from the report as a failed **assertion** or an **error** (an import error proves nothing
  about the bug).
- `migrate` runs `bench migrate`; `errors_since` lists new error signatures (exception and first app frame).

## Install

```
# worker server: prints the relay's public key
sudo bash install/relay.sh <fix server instance id> <fix server private address>
# fix server (reached with ssh -J through the worker): pulls the base images
sudo bash install/runner.sh "<the relay's public key>"
```

Then add `TBO_SANDBOX_SOCKET=/data/sandbox/runner.sock` to the worker's settings file and restart the worker
container: it claims fix jobs as well as investigations.

## Tests

`python3 -m unittest discover -s tests` (no Docker, SSH or AWS needed).
