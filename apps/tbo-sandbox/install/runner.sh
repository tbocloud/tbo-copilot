#!/usr/bin/env bash
# Installs the sandbox runner on the fix server (apps/tbo-sandbox/README.md). Safe to run again.
#
#   sudo bash install/runner.sh "<the relay's public key>"
#
# The relay's key may run the runner and nothing else (a forced command; no shell, no forwarding).
set -euo pipefail
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install/runner.sh \"<public key>\""
key=${1:-}
# exactly one key line: a second line would become an entry without the forced command
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}(\ [A-Za-z0-9._@-]+)?$ ]] || die "give the relay's one-line ssh-ed25519 public key"
here=$(cd "$(dirname "$0")/.." && pwd)
lib=/usr/local/lib/tbo-sandbox
sandboxes=/var/lib/tbo-worker/sandboxes
mountpoint -q "$sandboxes" || die "$sandboxes is not mounted: run tbocloud-infra's setup.sh sandbox first"

echo "== The runner"
install -d -m 755 "$lib/site"
install -m 755 "$here/runner.py" "$lib/runner.py"
install -m 644 "$here/site/Dockerfile" "$here/site/tbo_sandbox_site.py" "$lib/site/"
[ -s /etc/tbo-sandbox.json ] || echo '{"erpnext_image": "frappe/erpnext:v15.122.0"}' > /etc/tbo-sandbox.json

echo "== Its folders, for the ubuntu user (uid 1000, the same as frappe in the bench image)"
install -d -o ubuntu -g ubuntu -m 755 "$sandboxes/runs" "$sandboxes/snapshots"
chown ubuntu:ubuntu "$sandboxes"
# the busy marker the idle power-off reads (tbocloud-infra setup.sh owns this file)
echo 'd /run/tbo-worker 0755 ubuntu ubuntu -' > /etc/tmpfiles.d/tbo-worker.conf
systemd-tmpfiles --create /etc/tmpfiles.d/tbo-worker.conf
chown ubuntu:ubuntu /run/tbo-worker

echo "== The relay's key: the runner only"
keys=/home/ubuntu/.ssh/authorized_keys
line="restrict,command=\"/usr/bin/python3 $lib/runner.py\" $key"
grep -v 'tbo-sandbox/runner.py' "$keys" > "$keys.new" || true
echo "$line" >> "$keys.new"
install -o ubuntu -g ubuntu -m 600 "$keys.new" "$keys"
rm -f "$keys.new"

echo "== The images every sandbox starts from"
for image in $(python3 -c "import json; c=json.load(open('/etc/tbo-sandbox.json')); print(c.get('erpnext_image','frappe/erpnext:v15.122.0'))") mariadb:10.6 redis:7-alpine; do
  sudo -u ubuntu docker pull --quiet "$image" >/dev/null && echo "  $image"
done

echo "== Result"
echo '{"op": "ping"}' | sudo -u ubuntu python3 "$lib/runner.py"
