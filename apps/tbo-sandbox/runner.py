#!/usr/bin/env python3
"""TBO Copilot's sandbox runner, on the fix server (apps/tbo-sandbox/README.md).

The worker's relay reaches it over SSH as a forced command: one JSON request on stdin, one
JSON reply on stdout ({"ok": true, "result": ...} or {"ok": false, "error": "..."}). Only the
operations below exist; nothing here takes a command line from the request.

A sandbox is a Frappe site in Docker on an internal network (no internet): MariaDB, Redis
and a bench built from the official ERPNext image plus the customer's apps at their commits.
Each run gets a reflink copy of a snapshot of a fresh site with those apps installed, and
the app being fixed is mounted from the code the worker sends.
"""

import base64
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(os.environ.get("TBO_SANDBOX_ROOT", "/var/lib/tbo-worker/sandboxes"))
HERE = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get("TBO_SANDBOX_CONFIG", "/etc/tbo-sandbox.json"))
BUSY = Path("/run/tbo-worker/busy")

APP = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$")
SANDBOX_ID = re.compile(r"^sbx-[0-9a-f]{12}$")
COMMIT = re.compile(r"^[0-9a-f]{7,40}$")
REPOSITORY = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
DOCTYPE = re.compile(r"^[A-Za-z0-9 _-]{1,140}$")

SITE = "sandbox.localhost"
BENCH = "/home/frappe/frappe-bench"
IN_IMAGE = {"frappe", "erpnext"}  # the official image brings these two
MAX_OUTPUT = 64_000
MAX_CODE_BYTES = 200 * 1024 * 1024
OPS = {"ping", "start", "migrate", "check", "tests", "errors_since", "try_change_set", "stop"}


class Refused(Exception):
    """The request is not one the runner accepts; the message goes back to the worker."""


# --- small helpers ------------------------------------------------------------------------


def settings() -> dict:
    """The fix server's own settings: the ERPNext image to build on."""
    values = {"erpnext_image": "frappe/erpnext:v15.122.0", "mariadb_image": "mariadb:10.6", "redis_image": "redis:7-alpine"}
    if CONFIG.exists():
        values.update(json.loads(CONFIG.read_text()))
    return values


def touch_busy():
    """Keeps the fix server from powering itself off while a sandbox is in use."""
    try:
        BUSY.touch()
    except OSError:
        pass


def docker(*args: str, timeout: int = 600, check: bool = True, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    result = subprocess.run(["docker", *args], input=stdin, capture_output=True, timeout=timeout)
    if check and result.returncode != 0:
        raise Refused(f"docker {args[0]} failed: {tail(result.stderr or result.stdout)}")
    return result


def tail(data: bytes | str, limit: int = MAX_OUTPUT) -> str:
    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
    return text if len(text) <= limit else f"[… {len(text) - limit} characters cut]\n" + text[-limit:]


def names(sandbox: str) -> dict:
    return {key: f"tbo-{sandbox}-{key}" for key in ("db", "redis", "bench", "net")}


def run_dir(sandbox: str) -> Path:
    if not SANDBOX_ID.match(sandbox or ""):
        raise Refused(f"not a sandbox: {sandbox}")
    path = ROOT / "runs" / sandbox
    if not path.is_dir():
        raise Refused(f"no sandbox {sandbox} (stopped, or the fix server restarted)")
    return path


# --- the code the worker sends -------------------------------------------------------------


def unpack(code: dict, into: Path) -> str:
    """Puts the app's code the worker sent into `into`, in place: the directory itself stays,
    so a running container's bind mount sees the change. Returns the app's name."""
    app = code.get("app") or ""
    if not APP.match(app):
        raise Refused(f"not an app: {app}")
    raw = base64.b64decode(code.get("tar") or "", validate=True)
    if len(raw) > MAX_CODE_BYTES:
        raise Refused("the app's code is larger than 200 MB")
    with tempfile.TemporaryDirectory(dir=ROOT) as scratch, tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        archive.extractall(scratch, filter="data")  # refuses absolute paths, .. and links out
        sync(Path(scratch), into)
    return app


def sync(source: Path, target: Path):
    """Makes `target` hold exactly the files of `source`, keeping `target` itself."""
    target.mkdir(parents=True, exist_ok=True)
    wanted = {path.relative_to(source) for path in source.rglob("*")}
    for path in sorted(target.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.relative_to(target) not in wanted:
            path.unlink() if path.is_file() or path.is_symlink() else shutil.rmtree(path)
    for rel in sorted(wanted, key=lambda p: len(p.parts)):
        src, dst = source / rel, target / rel
        if src.is_dir():
            dst.mkdir(exist_ok=True)
        elif not dst.exists() or src.read_bytes() != dst.read_bytes():
            shutil.copy2(src, dst)


# --- images and snapshots ------------------------------------------------------------------


def app_set(spec: dict) -> list[dict]:
    """The site's apps, checked: the custom ones need a GitHub repository and a commit."""
    apps = []
    for item in spec.get("apps") or []:
        app = item.get("app") or ""
        if not APP.match(app):
            raise Refused(f"not an app: {app}")
        if app in IN_IMAGE:
            continue
        repository = (item.get("repository") or "").removesuffix(".git")
        commit = item.get("commit") or ""
        if not REPOSITORY.match(repository) or not COMMIT.match(commit):
            raise Refused(f"{app} needs its GitHub repository and the commit the site runs")
        apps.append({"app": app, "repository": repository, "commit": commit})
    return sorted(apps, key=lambda a: a["app"])


def fingerprint(root: Path) -> str:
    """The content of the code that goes into the image (not its times: each start unpacks afresh)."""
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not {".git", "node_modules"} & set(p.relative_to(root).parts)):
        digest.update(f"{path.relative_to(root)}\0".encode() + hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def key_of(image: str, apps: list[dict], code: str) -> str:
    """One image and snapshot per base image, set of apps, the fixed app's code and the recipe:
    the snapshot never holds what an earlier edit installed or migrated."""
    recipe = hashlib.sha256(b"".join((HERE / "site" / name).read_bytes() for name in ("Dockerfile", "tbo_sandbox_site.py"))).hexdigest()
    text = json.dumps({"image": image, "apps": apps, "code": code, "recipe": recipe}, sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def ensure_image(key: str, base: str, apps: list[dict], mounted: tuple[str, Path]) -> tuple[str, list[str]]:
    """The bench image for this set of apps: built once and kept. The app being fixed comes
    from the worker's code; the others are cloned at the commit the site runs."""
    tag = f"tbo-sandbox:{key}"
    found = docker("image", "inspect", "--format", '{{index .Config.Labels "tbo.missing"}}', tag, check=False)
    if found.returncode == 0:
        if not found.stdout.decode().strip():
            return tag, []
        # an app was missing when it was built (GitHub down, say): try again rather than reuse it
        docker("rmi", "-f", tag, check=False)
        shutil.rmtree(ROOT / "snapshots" / key, ignore_errors=True)
    notes = []
    with tempfile.TemporaryDirectory(dir=ROOT) as context:
        context = Path(context)
        (context / "apps").mkdir()
        for item in apps:
            target = context / "apps" / item["app"]
            if item["app"] == mounted[0]:
                shutil.copytree(mounted[1], target, ignore=shutil.ignore_patterns(".git", "node_modules"))
                continue
            clone = subprocess.run(["git", "clone", "--quiet", item["repository"], str(target)], capture_output=True, timeout=600)
            checkout = clone.returncode == 0 and subprocess.run(
                ["git", "-C", str(target), "checkout", "--quiet", item["commit"]], capture_output=True, timeout=120
            ).returncode == 0
            if not checkout:
                shutil.rmtree(target, ignore_errors=True)
                notes.append(f"{item['app']} could not be fetched at {item['commit'][:12]}, so the copy runs without it")
                continue
            shutil.rmtree(target / ".git", ignore_errors=True)
        shutil.copy(HERE / "site" / "Dockerfile", context / "Dockerfile")
        shutil.copy(HERE / "site" / "tbo_sandbox_site.py", context / "tbo_sandbox_site.py")
        missing = ",".join(item["app"] for item in apps if not (context / "apps" / item["app"]).exists())
        docker("build", "--quiet", "--build-arg", f"BASE={base}", "--label", f"tbo.missing={missing}", "-t", tag, str(context), timeout=3600)
    return tag, notes


def ensure_snapshot(key: str, image: str, config: dict) -> Path:
    """A fresh site with every app of the image installed, stopped and kept: each run copies it."""
    snapshot = ROOT / "snapshots" / key
    if (snapshot / "ready").exists():
        return snapshot
    shutil.rmtree(snapshot, ignore_errors=True)
    (snapshot / "db").mkdir(parents=True)
    password = secrets.token_hex(16)
    sandbox = f"prep-{key[:8]}"
    net, db, redis, bench = (f"tbo-{sandbox}-{x}" for x in ("net", "db", "redis", "bench"))
    try:
        docker("network", "create", "--internal", net)
        start_db(db, net, snapshot / "db", password, config)
        docker("run", "-d", "--name", redis, "--network", net, "--network-alias", "redis", config["redis_image"])
        copy_sites_out(image, snapshot / "sites")
        docker("run", "-d", "--name", bench, "--network", net, "-v", f"{snapshot / 'sites'}:{BENCH}/sites", image, "sleep", "infinity")
        wait_for_db(db, password)
        apps = [a for a in (snapshot / "sites" / "apps.txt").read_text().split() if a and a != "frappe"]
        new_site = ["bench", "new-site", SITE, "--db-root-password", password, "--admin-password", "admin", "--no-mariadb-socket"]
        for app in apps:
            new_site += ["--install-app", app]
        bench_exec(bench, *new_site, timeout=3600)
        for key_, value in (("allow_tests", "1"), ("mute_emails", "1"), ("pause_scheduler", "1"), ("developer_mode", "1")):
            bench_exec(bench, "bench", "--site", SITE, "set-config", key_, value, "--parse")
        docker("stop", "-t", "60", db)
        (snapshot / "meta.json").write_text(json.dumps({"image": image, "password": password, "apps": apps, "created": time.time()}))
        (snapshot / "ready").touch()
        return snapshot
    finally:
        for name in (bench, redis, db):
            docker("rm", "-f", name, check=False)
        docker("network", "rm", net, check=False)


def copy_sites_out(image: str, target: Path):
    """The image's sites folder (apps.txt, assets), with the sandbox's own common config."""
    holder = docker("create", image).stdout.decode().strip()
    try:
        target.mkdir(parents=True, exist_ok=True)
        docker("cp", f"{holder}:{BENCH}/sites/.", str(target))
    finally:
        docker("rm", "-f", holder, check=False)
    (target / "common_site_config.json").write_text(
        json.dumps({"db_host": "db", "redis_cache": "redis://redis:6379", "redis_queue": "redis://redis:6379", "redis_socketio": "redis://redis:6379", "socketio_port": 9000}, indent=1)
    )


def start_db(name: str, net: str, datadir: Path, password: str, config: dict):
    # as uid 1000 (the frappe and ubuntu users), so the reflink copies stay usable
    docker("run", "-d", "--name", name, "--network", net, "--network-alias", "db", "--user", "1000:1000",
           "-e", f"MARIADB_ROOT_PASSWORD={password}", "-v", f"{datadir}:/var/lib/mysql", config["mariadb_image"],
           "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci", "--skip-character-set-client-handshake")


def wait_for_db(name: str, password: str, seconds: int = 180):
    """Ready once it answers over TCP twice: on a first start MariaDB's entrypoint initialises
    with networking off (the socket answers), then restarts the server for real."""
    end, answered = time.time() + seconds, 0
    while time.time() < end:
        ping = ("exec", name, "mariadb-admin", "ping", "--protocol=tcp", "-h", "127.0.0.1", "-uroot", f"-p{password}", "--silent")
        answered = answered + 1 if docker(*ping, check=False, timeout=30).returncode == 0 else 0
        if answered >= 2:
            return
        time.sleep(2)
    raise Refused("the sandbox's database did not start")


def bench_exec(container: str, *args: str, timeout: int = 1800) -> subprocess.CompletedProcess:
    result = docker("exec", "-w", BENCH, container, *args, timeout=timeout, check=False)
    if result.returncode != 0:
        raise Refused(f"{' '.join(args[:3])} failed: {tail(result.stderr or result.stdout, 4000)}")
    return result


# --- the operations ------------------------------------------------------------------------


def op_start(request: dict) -> dict:
    spec = request.get("spec") or {}
    mount = spec.get("mount") or {}
    code = request.get("code") or {}
    if code.get("app") != mount.get("app"):
        raise Refused("start needs the code of the app being fixed")
    config = settings()
    apps = app_set(spec)
    if mount.get("app") not in {a["app"] for a in apps}:
        raise Refused(f"{mount.get('app')} is not among the site's apps")
    prune_old()
    sandbox = f"sbx-{secrets.token_hex(6)}"
    here = ROOT / "runs" / sandbox
    (here / "code").mkdir(parents=True)
    touch_busy()
    try:
        app = unpack(code, here / "code" / mount["app"])
        key = key_of(config["erpnext_image"], apps, fingerprint(here / "code" / app))
        image, notes = ensure_image(key, config["erpnext_image"], apps, (app, here / "code" / app))
        snapshot = ensure_snapshot(key, image, config)
        meta = json.loads((snapshot / "meta.json").read_text())
        subprocess.run(["cp", "-a", "--reflink=always", str(snapshot / "db"), str(snapshot / "sites"), str(here)], check=True, capture_output=True, timeout=600)
        n = names(sandbox)
        docker("network", "create", "--internal", n["net"])
        start_db(n["db"], n["net"], here / "db", meta["password"], config)
        docker("run", "-d", "--name", n["redis"], "--network", n["net"], "--network-alias", "redis", config["redis_image"])
        docker("run", "-d", "--name", n["bench"], "--network", n["net"], "-v", f"{here / 'sites'}:{BENCH}/sites",
               "-v", f"{here / 'code' / app}:{BENCH}/apps/{app}", image, "sleep", "infinity")
        wait_for_db(n["db"], meta["password"])
        (here / "meta.json").write_text(json.dumps({"app": app, "image": image, "run": spec.get("run"), "started": time.time()}))
    except BaseException:
        stop(sandbox)
        raise
    version = config["erpnext_image"].rsplit(":", 1)[-1]
    note = "; ".join(notes + [f"Frappe and ERPNext come from the official image {config['erpnext_image']}, not the site's exact commits"])
    return {"id": sandbox, "tested_on": f"a fresh ERPNext {version} site with the customer's apps (no customer data)", "note": note}


def refresh_code(request: dict, here: Path):
    if request.get("code"):
        meta = json.loads((here / "meta.json").read_text())
        if request["code"].get("app") != meta["app"]:
            raise Refused("this sandbox runs another app")
        unpack(request["code"], here / "code" / meta["app"])


def run_bench(sandbox: str, args: list[str], timeout: int) -> dict:
    started = time.time()
    try:
        result = docker("exec", "-w", BENCH, names(sandbox)["bench"], *args, timeout=timeout, check=False)
        output, code = (result.stdout + result.stderr), result.returncode
    except subprocess.TimeoutExpired:
        output, code = f"stopped after {timeout} seconds".encode(), 124
    return {"ok": code == 0, "exit_code": code, "output": tail(output), "ms": int((time.time() - started) * 1000)}


def junit(sandbox: str) -> dict:
    """What the test report says: how many ran, failed an assertion, or errored."""
    result = docker("exec", names(sandbox)["bench"], "cat", "/tmp/tbo-junit.xml", check=False)
    docker("exec", names(sandbox)["bench"], "rm", "-f", "/tmp/tbo-junit.xml", check=False)
    if result.returncode != 0 or not result.stdout.strip():
        return {}
    root = ET.fromstring(result.stdout)
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    count = lambda attr: sum(int(s.get(attr) or 0) for s in suites)  # noqa: E731
    return {"tests": count("tests"), "failures": count("failures"), "errors": count("errors"), "skipped": count("skipped")}


def tested(sandbox: str, args: list[str], timeout: int) -> dict:
    """A test run, classified from its report: a failed assertion or an error, never guessed from the words."""
    result = run_bench(sandbox, [*args, "--junit-xml-output", "/tmp/tbo-junit.xml"], timeout)
    report = junit(sandbox)
    if report and report["tests"] == 0 and result["ok"]:
        return {**result, "ok": True, "skipped": True}
    if result["ok"] and report.get("failures", 0) == 0 and report.get("errors", 0) == 0:
        return result
    failure = "assertion" if report and report["failures"] > 0 and report["errors"] == 0 else "error"
    return {**result, "ok": False, "failure": failure}


def op_check(request: dict) -> dict:
    here = run_dir(request.get("id"))
    app, module = request.get("app") or "", request.get("module") or ""
    if not APP.match(app) or not MODULE.match(module) or not module.startswith(f"{app}."):
        raise Refused(f"not a test module of {app}: {module}")
    refresh_code(request, here)
    return tested(request["id"], ["bench", "--site", SITE, "run-tests", "--module", module], 1200)


def op_tests(request: dict) -> dict:
    here = run_dir(request.get("id"))
    app = request.get("app") or ""
    if not APP.match(app):
        raise Refused(f"not an app: {app}")
    refresh_code(request, here)
    return tested(request["id"], ["bench", "--site", SITE, "run-tests", "--app", app], 2400)


def op_migrate(request: dict) -> dict:
    here = run_dir(request.get("id"))
    refresh_code(request, here)
    return run_bench(request["id"], ["bench", "--site", SITE, "migrate"], 2400)


def site_call(sandbox: str, method: str, kwargs: dict, timeout: int = 600):
    result = run_bench(sandbox, ["bench", "--site", SITE, "execute", f"frappe.tbo_sandbox_site.{method}", "--kwargs", json.dumps(kwargs)], timeout)
    if not result["ok"]:
        raise Refused(f"the sandbox could not answer {method}: {result['output'][-1500:]}")
    lines = [line for line in result["output"].splitlines() if line.strip()]
    return json.loads(lines[-1]) if lines else None


def op_errors_since(request: dict) -> list:
    run_dir(request.get("id"))
    since = str(request.get("since") or "")
    if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", since):
        raise Refused(f"not a time: {since}")
    return site_call(request["id"], "error_signatures", {"since": since}) or []


def op_try_change_set(request: dict) -> list:
    here = run_dir(request.get("id"))
    changes = request.get("changes")
    if not isinstance(changes, list) or len(changes) > 1000:
        raise Refused("changes must be a list of at most 1,000 records")
    for change in changes:
        if not isinstance(change, dict) or not DOCTYPE.match(str(change.get("doctype") or "")):
            raise Refused("each change names its doctype")
    refresh_code(request, here)
    return site_call(request["id"], "try_changes", {"changes": changes}, timeout=1800) or []


def stop(sandbox: str):
    n = names(sandbox)
    for key in ("bench", "redis", "db"):
        docker("rm", "-f", n[key], check=False)
    docker("network", "rm", n["net"], check=False)
    shutil.rmtree(ROOT / "runs" / sandbox, ignore_errors=True)


def prune_old(hours: int = 24):
    """Removes sandboxes older than a day: their worker died before `stop`."""
    for path in (ROOT / "runs").glob("sbx-*"):
        if SANDBOX_ID.match(path.name) and time.time() - path.stat().st_mtime > hours * 3600:
            stop(path.name)


def op_stop(request: dict) -> None:
    sandbox = request.get("id") or ""
    if not SANDBOX_ID.match(sandbox):
        raise Refused(f"not a sandbox: {sandbox}")
    stop(sandbox)


def handle(request: dict):
    op = request.get("op")
    if op not in OPS:
        raise Refused(f"unknown operation: {op}")
    touch_busy()
    if op == "ping":
        return {"runner": 1, "sandboxes": sorted(p.name for p in (ROOT / "runs").glob("sbx-*"))}
    return globals()[f"op_{op}"](request)


def main() -> int:
    raw = sys.stdin.buffer.readline()
    working = threading.Event()

    def keep_busy():  # a first start builds an image and a snapshot for half an hour
        while not working.wait(60):
            touch_busy()

    threading.Thread(target=keep_busy, daemon=True).start()
    try:
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise Refused("a request is one JSON object")
        reply = {"ok": True, "result": handle(request)}
    except Refused as e:
        reply = {"ok": False, "error": str(e)}
    except (ValueError, KeyError, TypeError) as e:
        reply = {"ok": False, "error": f"the request could not be read: {e}"}
    except Exception as e:  # noqa: BLE001 - any other failure is still one JSON reply
        reply = {"ok": False, "error": f"{type(e).__name__}: {tail(str(e), 1500)}"}
    working.set()
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
