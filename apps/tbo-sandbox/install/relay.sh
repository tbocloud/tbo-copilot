#!/usr/bin/env bash
# Installs the sandbox relay on the worker server (apps/tbo-sandbox/README.md). Safe to run again.
#
#   sudo bash install/relay.sh <fix server instance id> <fix server private address>
#
# Prints the relay's public key: install it on the fix server with install/runner.sh.
set -euo pipefail
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install/relay.sh <instance id> <address>"
instance=${1:-}
host=${2:-}
[[ "$instance" =~ ^i-[0-9a-f]{8,17}$ ]] || die "the first argument is the fix server's instance id (i-…)"
[[ "$host" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the second argument is the fix server's private address (10.…)"
here=$(cd "$(dirname "$0")/.." && pwd)
lib=/usr/local/lib/tbo-sandbox

echo "== The relay"
install -d -m 755 "$lib"
install -m 755 "$here/relay.py" "$lib/relay.py"
python3 - "$instance" "$host" <<'PY'
import json, pathlib, sys
path = pathlib.Path("/etc/tbo-sandbox-relay.json")
config = json.loads(path.read_text()) if path.exists() else {}
config.update({"instance_id": sys.argv[1], "host": sys.argv[2]})
path.write_text(json.dumps(config, indent=1) + "\n")
PY

echo "== Its key (only for the fix server's runner)"
key=/home/ubuntu/.ssh/tbo_sandbox
[ -f "$key" ] || sudo -u ubuntu ssh-keygen -q -t ed25519 -N "" -C tbo-sandbox-relay -f "$key"
install -d -o ubuntu -g ubuntu -m 700 /var/lib/tbo-worker/sandbox

echo "== The service"
cat > /etc/systemd/system/tbo-sandbox-relay.service <<UNIT
[Unit]
Description=TBO Copilot sandbox relay (starts the fix server, passes sandbox requests to its runner)
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
ExecStart=/usr/bin/python3 $lib/relay.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q tbo-sandbox-relay
systemctl restart tbo-sandbox-relay

echo "== Result"
sleep 2
echo "relay: $(systemctl is-active tbo-sandbox-relay); socket: $(ls /var/lib/tbo-worker/sandbox/runner.sock 2>/dev/null || echo missing)"
echo "The relay's public key, for install/runner.sh on the fix server:"
cat "$key.pub"
