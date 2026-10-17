#!/usr/bin/env python3
"""TBO Copilot's sandbox relay, on the worker server (apps/tbo-sandbox/README.md).

The worker program speaks to a sandbox runner over a local socket (TBO_SANDBOX_SOCKET, one
JSON request per line). The runner lives on the fix server, which is off until a fix needs
it, so this relay holds that socket and, for each request:

- starts the fix server when it is off (the worker's role may do exactly that: StartInstances);
- adds the app's code from the worker's clone when it changed since the last request;
- passes the request over SSH, where the fix server runs the runner as a forced command;
- while a sandbox is open, tells the runner once a minute, so the fix server stays on.
"""

import base64
import datetime
import hashlib
import hmac
import io
import json
import os
import re
import socket
import socketserver
import subprocess
import tarfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get("TBO_SANDBOX_RELAY_CONFIG", "/etc/tbo-sandbox-relay.json"))
SKIP = {".git", "node_modules", "__pycache__", ".pytest_cache"}
CODE_OPS = {"start", "check", "tests", "migrate", "try_change_set"}
IMDS = "http://169.254.169.254/latest"


def settings() -> dict:
    values = {
        "socket": "/var/lib/tbo-worker/sandbox/runner.sock",
        # the worker container sees the server's /var/lib/tbo-worker as /data
        "paths": {"/data": "/var/lib/tbo-worker"},
        "user": "ubuntu",
        "key": str(Path.home() / ".ssh" / "tbo_sandbox"),
        "region": "ap-south-1",
        "timeout": 3600,
        # the only folder the worker's clones may come from, and how long a sandbox may stay open
        "code_root": "/var/lib/tbo-worker/runs",
        "max_open_hours": 3,
    }
    values.update(json.loads(CONFIG.read_text()))
    for needed in ("instance_id", "host"):
        if not values.get(needed):
            raise SystemExit(f"{CONFIG} needs {needed}")
    return values


# --- the app's code ------------------------------------------------------------------------


def host_path(path: str, paths: dict, root: str) -> Path | None:
    """The worker's path for its clone, as seen on this server; None unless it is a mapped path
    that stays inside `root` once `..` and links are resolved."""
    for inside, outside in paths.items():
        if path == inside or path.startswith(inside.rstrip("/") + "/"):
            found = Path(outside + path[len(inside.rstrip("/")):]).resolve()
            return found if found.is_relative_to(Path(root).resolve()) else None
    return None


def fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(files(root)):
        stat = path.stat()
        digest.update(f"{path.relative_to(root)}:{stat.st_size}:{stat.st_mtime_ns}\n".encode())
    return digest.hexdigest()


def files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink() and not SKIP & set(path.relative_to(root).parts):
            yield path


def pack(app: str, root: Path) -> dict:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path in sorted(files(root)):
            archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
    return {"app": app, "tar": base64.b64encode(buffer.getvalue()).decode()}


# --- starting the fix server ---------------------------------------------------------------


def credentials() -> tuple[str, str, str]:
    """The worker's role, from the instance metadata service (IMDSv2)."""
    token = urllib.request.urlopen(
        urllib.request.Request(f"{IMDS}/api/token", method="PUT", headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}),
        timeout=5,
    ).read().decode()
    headers = {"X-aws-ec2-metadata-token": token}
    base = f"{IMDS}/meta-data/iam/security-credentials/"
    role = urllib.request.urlopen(urllib.request.Request(base, headers=headers), timeout=5).read().decode().split()[0]
    found = json.loads(urllib.request.urlopen(urllib.request.Request(base + role, headers=headers), timeout=5).read())
    return found["AccessKeyId"], found["SecretAccessKey"], found["Token"]


def signed(region: str, body: str, key: str, secret: str, token: str, now: datetime.datetime) -> dict:
    """AWS Signature Version 4 headers for one EC2 query-API POST."""
    host = f"ec2.{region}.amazonaws.com"
    stamp, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    headers = {"content-type": "application/x-www-form-urlencoded; charset=utf-8", "host": host, "x-amz-date": stamp, "x-amz-security-token": token}
    names = ";".join(sorted(headers))
    canonical = "\n".join(["POST", "/", "", *(f"{k}:{headers[k]}" for k in sorted(headers)), "", names, hashlib.sha256(body.encode()).hexdigest()])
    scope = f"{day}/{region}/ec2/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signing = f"AWS4{secret}".encode()
    for part in (day, region, "ec2", "aws4_request"):
        signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={key}/{scope}, SignedHeaders={names}, Signature={signature}"
    return headers


def start_fix_server(config: dict) -> str:
    """Asks EC2 to start the fix server (nothing happens when it runs already); returns its state."""
    key, secret, token = credentials()
    body = urllib.parse.urlencode({"Action": "StartInstances", "Version": "2016-11-15", "InstanceId.1": config["instance_id"]})
    headers = signed(config["region"], body, key, secret, token, datetime.datetime.now(datetime.timezone.utc))
    request = urllib.request.Request(f"https://{headers['host']}/", data=body.encode(), method="POST", headers=headers)
    reply = urllib.request.urlopen(request, timeout=30).read().decode()
    found = re.search(r"<currentState>.*?<name>(\w+)</name>", reply, re.S)
    return found.group(1) if found else "unknown"


def ssh_ready(host: str, seconds: int = 300) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            with socket.create_connection((host, 22), timeout=5):
                return True
        except OSError:
            time.sleep(5)
    return False


# --- passing requests on -------------------------------------------------------------------


class Relay:
    def __init__(self, config: dict):
        self.config = config
        self.lock = threading.Lock()
        self.open: dict[str, dict] = {}  # sandbox id -> {"app", "root", "sent", "since"}

    def runner(self, request: dict, timeout: int | None = None) -> dict:
        command = ["ssh", "-i", self.config["key"], "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
                   "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=20", f"{self.config['user']}@{self.config['host']}"]
        try:
            done = subprocess.run(command, input=(json.dumps(request) + "\n").encode(), capture_output=True,
                                  timeout=timeout or self.config["timeout"])
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"the sandbox runner did not answer {request.get('op')} in time"}
        lines = [line for line in done.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
        try:
            return json.loads(lines[-1])
        except (IndexError, ValueError):
            return {"ok": False, "error": f"the fix server did not answer {request.get('op')}: {done.stderr.decode('utf-8', 'replace')[-500:]}"}

    def ensure_on(self) -> dict | None:
        try:
            state = start_fix_server(self.config)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"the fix server could not be started: {e}"}
        if not ssh_ready(self.config["host"]):
            return {"ok": False, "error": f"the fix server did not come up (it was {state})"}
        return None

    def handle(self, request: dict) -> dict:
        op = request.get("op")
        with self.lock:
            if op == "start":
                mount = (request.get("spec") or {}).get("mount") or {}
                root = host_path(str(mount.get("dir") or ""), self.config["paths"], self.config["code_root"])
                if not root or not root.is_dir():
                    return {"ok": False, "error": f"the app's clone is not on this server: {mount.get('dir')}"}
                request["code"] = pack(str(mount.get("app")), root)
                sent = fingerprint(root)
            elif op in CODE_OPS and request.get("id") in self.open:
                known = self.open[request["id"]]
                sent = fingerprint(known["root"])
                if sent != known["sent"]:
                    request["code"] = pack(known["app"], known["root"])
            failed = self.ensure_on()
            if failed:
                return failed
            reply = self.runner(request)
            if op == "start" and reply.get("ok"):
                self.open[reply["result"]["id"]] = {"app": request["code"]["app"], "root": root, "sent": sent, "since": time.time()}
            elif op in CODE_OPS and reply.get("ok") and request.get("id") in self.open and request.get("code"):
                self.open[request["id"]]["sent"] = sent
            elif op == "stop":
                self.open.pop(request.get("id"), None)
            return reply

    def prune(self, live: set[str] | None):
        """Forgets sandboxes the runner no longer has, and any open longer than a fix may take
        (a worker that died before `stop`): otherwise the pings would keep the fix server on."""
        oldest = time.time() - self.config["max_open_hours"] * 3600
        for sandbox, known in list(self.open.items()):
            if (live is not None and sandbox not in live) or known["since"] < oldest:
                self.open.pop(sandbox, None)

    def keep_awake(self):
        """Once a minute while a sandbox is open: the runner's ping touches the fix server's busy marker."""
        while True:
            time.sleep(60)
            if self.open and self.lock.acquire(blocking=False):
                try:
                    self.prune(None)
                    if self.open:
                        reply = self.runner({"op": "ping"}, timeout=60)
                        if reply.get("ok"):
                            self.prune(set((reply.get("result") or {}).get("sandboxes") or []))
                finally:
                    self.lock.release()


def serve(config: dict):
    relay = Relay(config)
    path = Path(config["socket"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            line = self.rfile.readline()
            try:
                request = json.loads(line)
                reply = relay.handle(request) if isinstance(request, dict) else {"ok": False, "error": "one JSON object per line"}
            except ValueError:
                reply = {"ok": False, "error": "the request could not be read"}
            self.wfile.write((json.dumps(reply) + "\n").encode())

    threading.Thread(target=relay.keep_awake, daemon=True).start()
    with socketserver.ThreadingUnixStreamServer(str(path), Handler) as server:
        os.chmod(path, 0o660)
        server.serve_forever()


if __name__ == "__main__":
    serve(settings())
