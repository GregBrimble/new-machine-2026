#!/bin/bash
# Host driver; the guest starts the test in Terminal so privacy prompts are visible.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: /bin/bash vm/run.sh [--local] [--image <Tart image>]

Creates a disposable, visible macOS Tahoe VM. By default it tests the published
curl entry point; --local tests a snapshot of this checkout instead.
In the VM, open /Volumes/My Shared Files/bootstrap-input/start.command.
Approve the normal macOS privacy prompts there. The driver restarts the VM to
check login startup, saves logs, and deletes the test VM only after success.
Requires Tart, Apple Silicon, and at least 60 GiB of free disk space.
EOF
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
mode=published
image=ghcr.io/cirruslabs/macos-tahoe-vanilla:latest
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode=local; shift ;;
    --image) [[ $# -ge 2 && -n "$2" ]] || fail '--image needs a value'; image=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'Requires an Apple Silicon Mac.'
command -v tart >/dev/null || fail 'Install Tart first: brew install openai/tools/tart'
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
available="$(df -Pk "${TMPDIR:-/tmp}" | awk 'END {print $4}')"
[[ "$available" =~ ^[0-9]+$ && "$available" -ge 62914560 ]] || fail 'At least 60 GiB free is required for the image, VM, and installations.'

artifacts="$(mktemp -d "${TMPDIR:-/tmp}/new-machine-vm.XXXXXX")"
mkdir "$artifacts/input" "$artifacts/results"
vm="new-machine-test-$(uuidgen | tr '[:upper:]' '[:lower:]')"
created=false
vm_pid=""
stop_vm() {
  if [[ -n "$vm_pid" ]]; then
    tart stop "$vm" >/dev/null 2>&1 || kill "$vm_pid" 2>/dev/null || true
    wait "$vm_pid" || true
    vm_pid=""
  fi
}
cleanup() {
  local result=$?
  trap - EXIT
  stop_vm
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
  tart run "$vm" --no-clipboard --no-audio \
    --dir="bootstrap-input:$artifacts/input:ro" \
    --dir="bootstrap-results:$artifacts/results" >> "$artifacts/results/tart.log" 2>&1 &
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
boot
printf '\nIn the VM (admin/admin), open Finder > Go > Go to Folder and enter:\n'
printf '  /Volumes/My Shared Files/bootstrap-input/start.command\n'
printf 'Follow the instructions in its Terminal window. Results: %s\n' "$artifacts/results"
wait_for reboot-required
printf 'First pass succeeded. Restarting the VM to check login startup.\n'
stop_vm
boot
wait_for passed
printf 'VM smoke test passed, including repeat application and login startup.\n'
