#!/bin/bash
# Host driver; the guest starts the test in Terminal so privacy prompts are visible.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: /bin/bash vm/run.sh [--local] [--attended] [--image <Tart image>] [--ca-bundle <PEM file>]

Creates a disposable macOS Tahoe VM and operates its UI automatically. By default it tests the published
curl entry point; --local tests a snapshot of this checkout instead.
Use --attended to operate the VM yourself instead. The normal privacy prompts
are approved only inside the disposable guest. The driver restarts the VM to
check login startup, saves logs, and deletes the test VM only after success.
Requires Tart and Apple Silicon; unattended mode also needs Python 3.11+ and Swift tools.
Allow 60 GiB free (30 GiB with a cached image).
For an inspecting proxy, --ca-bundle shares public CA certificates with the guest.
EOF
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
mode=published
image=ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640
attended=false
ca_bundle=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode=local; shift ;;
    --attended) attended=true; shift ;;
    --image) [[ $# -ge 2 && -n "$2" ]] || fail '--image needs a value'; image=$2; shift 2 ;;
    --ca-bundle) [[ $# -ge 2 && -n "$2" ]] || fail '--ca-bundle needs a value'; ca_bundle=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
if [[ -n "$ca_bundle" ]]; then
  [[ -f "$ca_bundle" && -r "$ca_bundle" ]] || fail 'CA bundle must be a readable PEM file.'
  case "$(cat "$ca_bundle")" in *'PRIVATE KEY'*) fail 'CA bundle must not contain private keys.' ;; esac
  /usr/bin/openssl x509 -in "$ca_bundle" -noout >/dev/null 2>&1 || fail 'CA bundle must contain PEM certificates.'
fi
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'Requires an Apple Silicon Mac.'
command -v tart >/dev/null || fail 'Install Tart first: brew install openai/tools/tart'
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
available="$(df -Pk "${TMPDIR:-/tmp}" | awk 'END {print $4}')"
required_gib=60
if tart list --quiet | awk -v image="$image" '$0 == image {found=1} END {exit !found}'; then
  required_gib=30
fi
[[ "$available" =~ ^[0-9]+$ && "$available" -ge $((required_gib * 1048576)) ]] || \
  fail "At least $required_gib GiB free is required for the image, VM, and installations."

artifacts="$(mktemp -d "${TMPDIR:-/tmp}/new-machine-vm.XXXXXX")"
mkdir "$artifacts/input" "$artifacts/results"
if [[ -n "$ca_bundle" ]]; then cp "$ca_bundle" "$artifacts/input/network-ca.pem"; fi
vm="new-machine-test-$(uuidgen | tr '[:upper:]' '[:lower:]')"
created=false
vm_pid=""
ui_python=""
if [[ "$attended" == false ]]; then
  command -v python3 >/dev/null || fail 'Unattended testing requires Python 3.11 or newer.'
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail 'Unattended testing requires Python 3.11 or newer.'
  command -v xcrun >/dev/null || fail 'Unattended testing requires Swift command line tools.'
  ui_cache="${XDG_CACHE_HOME:-$HOME/Library/Caches}/new-machine-2026/vm-ui"
  requirements_hash="$(shasum -a 256 "$repo/vm/requirements.txt" | awk '{print $1}')"
  python_version="$(python3 --version | tr ' ' '-')"
  ui_runtime="$ui_cache/$python_version-$requirements_hash"
  if [[ ! -x "$ui_runtime/bin/python" ]]; then
    python3 -m venv "$ui_runtime"
  fi
  ui_python="$ui_runtime/bin/python"
  "$ui_python" -m pip install --quiet --disable-pip-version-check -r "$repo/vm/requirements.txt"
  xcrun swiftc -module-cache-path "$ui_cache/swift-modules" "$repo/vm/ocr.swift" -o "$artifacts/ocr"
fi
stop_vm() {
  if [[ -n "$vm_pid" ]]; then
    tart stop "$vm" >/dev/null 2>&1 || kill "$vm_pid" 2>/dev/null || true
    wait "$vm_pid" || true
    cat "$artifacts/results/tart-current.log" >> "$artifacts/results/tart.log"
    vm_pid=""
  fi
}
cleanup() {
  local result=$?
  trap - EXIT
  stop_vm
  rm -f "$artifacts/ssh-askpass"
  if [[ "$created" == true && "$result" == 0 ]]; then
    tart delete "$vm" || result=$?
  elif [[ "$created" == true ]]; then
    printf 'VM preserved for inspection: %s\n' "$vm" >&2
    printf 'Delete it when finished: tart delete %s\n' "$vm" >&2
  fi
  printf 'Logs and results: %s\n' "$artifacts/results"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Keep an unattended run awake until this driver exits.
if [[ -x /usr/bin/caffeinate ]]; then /usr/bin/caffeinate -i -w $$ >/dev/null 2>&1 & fi

tar -czf "$artifacts/input/source.tar.gz" -C "$repo" \
  bootstrap.sh package.json package-lock.json .node-version src vm
cp "$repo/vm/guest.command" "$artifacts/input/start.command"
chmod +x "$artifacts/input/start.command"
printf '%s\n' "$mode" > "$artifacts/input/mode"
printf '%s\n' "$image" > "$artifacts/results/image.txt"
git -C "$repo" rev-parse HEAD > "$artifacts/results/checkout-commit.txt"
git -C "$repo" diff HEAD -- bootstrap.sh package.json package-lock.json .node-version src vm > "$artifacts/results/checkout.diff"
shasum -a 256 "$artifacts/input/source.tar.gz" > "$artifacts/results/snapshot.sha256"
tart --version > "$artifacts/results/tart-version.txt"
printf 'Cloning %s into %s\n' "$image" "$vm"
tart clone "$image" "$vm"
created=true

boot() {
  local display=()
  if [[ "$attended" == false ]]; then display=(--no-graphics --vnc-experimental); fi
  : > "$artifacts/results/tart-current.log"
  tart run "$vm" ${display[@]+"${display[@]}"} --no-clipboard --no-audio \
    --dir="bootstrap-input:$artifacts/input:ro" \
    --dir="bootstrap-results:$artifacts/results" > "$artifacts/results/tart-current.log" 2>&1 &
  vm_pid=$!
}
wait_for() {
  local desired=$1 deadline=$((SECONDS + 5400)) state
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    kill -0 "$vm_pid" 2>/dev/null || fail 'VM exited before the test finished; inspect tart.log.'
    state="$(cat "$artifacts/results/status" 2>/dev/null || true)"
    [[ "$state" != failed ]] || fail 'Guest test failed; inspect its logs.'
    [[ "$state" != "$desired" ]] || return 0
    sleep 2
  done
  fail 'Timed out after 90 minutes waiting for the guest test.'
}
automate() {
  local stage=$1 endpoint="" deadline=$((SECONDS + 120))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    kill -0 "$vm_pid" 2>/dev/null || fail 'VM exited before its VNC endpoint was ready.'
    endpoint="$(awk '/VNC server is running at vnc:/ {print $NF}' "$artifacts/results/tart-current.log" | tail -n 1)"
    [[ -z "$endpoint" ]] || break
    sleep 1
  done
  [[ -n "$endpoint" ]] || fail 'Timed out waiting for the VM VNC endpoint.'
  "$ui_python" -B "$repo/vm/ui.py" --endpoint "$endpoint" --ocr "$artifacts/ocr" \
    --results "$artifacts/results" --stage "$stage" 2>&1 | tee -a "$artifacts/results/ui.log"
}

start_guest() {
  local address deadline=$((SECONDS + 600))
  address="$(tart ip "$vm" --wait 120)" || fail 'VM has no DHCP lease; see vm/README.md for the host bootpd check.'
  # Public credentials belong only to the disposable test image. Never offer
  # host keys or an agent to the guest; open the script in the GUI Terminal so
  # its normal privacy prompts and permissions are exercised.
  (umask 077; printf '#!/bin/sh\nprintf "%%s\\n" admin\n' > "$artifacts/ssh-askpass")
  chmod 700 "$artifacts/ssh-askpass"
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if SSH_ASKPASS="$artifacts/ssh-askpass" SSH_ASKPASS_REQUIRE=force \
      ssh -F /dev/null -T -o IdentityAgent=none -o PubkeyAuthentication=no \
      -o PreferredAuthentications=password -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o ConnectionAttempts=1 -o NumberOfPasswordPrompts=1 \
      "admin@$address" "/usr/bin/open -a Terminal '/Volumes/My Shared Files/bootstrap-input/start.command'" \
      > "$artifacts/results/guest-start.log" 2>&1; then
      rm "$artifacts/ssh-askpass"
      return
    fi
    kill -0 "$vm_pid" 2>/dev/null || fail 'VM exited before SSH startup was ready.'
    sleep 2
  done
  rm "$artifacts/ssh-askpass"
  fail 'Timed out opening the guest test in Terminal; inspect guest-start.log.'
}

boot
if [[ "$attended" == true ]]; then
printf '\nIn the VM (admin/admin), open Finder > Go > Go to Folder and enter:\n'
printf '  /Volumes/My Shared Files/bootstrap-input/start.command\n'
printf 'Follow the instructions in its Terminal window. Results: %s\n' "$artifacts/results"
else
  printf 'Operating the disposable guest automatically. Results: %s\n' "$artifacts/results"
  start_guest
  automate first
fi
wait_for reboot-required
printf 'First pass succeeded. Restarting the VM to check login startup.\n'
stop_vm
boot
if [[ "$attended" == false ]]; then automate after-login; fi
wait_for passed
printf 'VM smoke test passed, including repeat application and login startup.\n'
