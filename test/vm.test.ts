import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const script = join(repo, "vm/run.ts")

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "new-machine-vm-driver-"))
  const bin = join(root, "bin")
  const log = join(root, "commands")
  mkdirSync(bin)
  const executable = (name: string, body: string) => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`); chmodSync(path, 0o755)
  }
  executable("uname", 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi')
  executable("df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000000 0 %s 0%% /\\n" "${FIXTURE_AVAILABLE:-100000000}"')
  executable("tart", `
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
  --version) echo 'Tart fixture' ;;
  list) printf '%s\\n' "\${FIXTURE_CACHED_IMAGE:-}" ;;
  clone|set|delete) ;;
  ip) echo 192.0.2.1 ;;
  run)
    for arg in "$@"; do
      case "$arg" in --dir=bootstrap-results:*) output="\${arg#--dir=bootstrap-results:}" ;; esac
    done
    printf '%s\\n' 'VNC server is running at vnc://:fixture@127.0.0.1:5900'
    echo $$ > "$FIXTURE_ROOT/vm-pid"
    [[ "\${FIXTURE_RUN_FAIL:-}" != true ]] || exit 2
    echo "$output" > "$FIXTURE_ROOT/output"
    if [[ ! -f "$FIXTURE_ROOT/first-boot" ]]; then
      touch "$FIXTURE_ROOT/first-boot"
      if [[ " $* " != *" --vnc-experimental "* ]]; then
        printf '%s\\n' "\${FIXTURE_FIRST_STATUS:-reboot-required}" > "$output/status"
      fi
    else
      if [[ " $* " != *" --vnc-experimental "* ]]; then echo passed > "$output/status"; fi
    fi
    trap 'exit 0' TERM
    while :; do sleep 0.1; done ;;
  stop) kill "$(cat "$FIXTURE_ROOT/vm-pid")" ;;
  *) exit 97 ;;
esac`)
  executable("python3", `
if [[ "$1" == --version ]]; then echo 'Python 3.14.0'; exit; fi
if [[ "$1" == -c ]]; then exit; fi
if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  exit
fi
if [[ "$1" == -m && "$2" == pip ]]; then exit; fi
[[ "$1" == -B && "$2" == */vm/ui.py ]] || exit 97
printf 'ui %s\\n' "$*" >> "$FIXTURE_LOG"
[[ "\${FIXTURE_UI_FAIL:-}" != true ]] || exit 1
output="$(cat "$FIXTURE_ROOT/output")"
touch "$output/guest-first.log"
if [[ -f "$FIXTURE_ROOT/ui-first" ]]; then echo passed > "$output/status"
else touch "$FIXTURE_ROOT/ui-first"; echo reboot-required > "$output/status"; fi
trap 'exit 0' TERM
while :; do sleep 0.1; done
`)
  executable("ssh", 'printf "ssh %s\\n" "$*" >> "$FIXTURE_LOG"')
  executable("xcrun", 'touch "${@: -1}"')
  const env = (extra: Record<string, string>) => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: root,
    FIXTURE_ROOT: root, FIXTURE_LOG: log, XDG_CACHE_HOME: root, ...extra })
  const run = (extra: Record<string, string> = {}, args: string[] = ["--local", "--attended"]) => spawnSync(process.execPath, [script, ...args], {
    cwd: repo, encoding: "utf8", timeout: 20_000, env: env(extra)
  })
  const start = () => spawn(process.execPath, [script, "--local", "--attended"], { cwd: repo, env: env({ FIXTURE_FIRST_STATUS: "waiting" }), stdio: ["ignore", "pipe", "pipe"] })
  return { root, run, start, commands: () => readFileSync(log, "utf8").trim().split("\n"),
    dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test("VM driver restarts its own disposable clone and deletes it only after success", () => {
  const f = fixture()
  try {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const commands = f.commands()
    const clone = commands.find(line => line.startsWith("clone "))!
    assert.ok(clone.includes("macos-tahoe-vanilla@sha256:"))
    const name = clone.split(" ").at(-1)!
    assert.match(name, /^new-machine-test-[0-9a-f-]+$/u)
    assert.equal(commands.filter(line => line.startsWith(`run ${name} `)).length, 2)
    assert.equal(commands.filter(line => line === `stop ${name}`).length, 2)
    assert.deepEqual(commands.filter(line => line.startsWith("delete ")), [`delete ${name}`])
    assert.ok(commands.filter(line => line.startsWith("run ")).every(line => line.includes(":ro --dir=bootstrap-results:")))
    assert.match(result.stdout, /VM smoke test passed/u)
    const artifacts = /Results: (.+)/u.exec(result.stdout)![1]
    assert.equal(readFileSync(join(artifacts, "status"), "utf8"), "passed\n")
  } finally { f.dispose() }
})

test("a failed guest test stops and preserves the VM for inspection", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_FIRST_STATUS: "failed" })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Guest test failed/u)
    assert.match(result.stderr, /VM preserved for inspection: new-machine-test-/u)
    assert.equal(f.commands().filter(line => line.startsWith("stop ")).length, 1)
    assert.equal(f.commands().some(line => line.startsWith("delete ")), false)
  } finally { f.dispose() }
})

test("insufficient disk space fails before cloning or starting a VM", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_AVAILABLE: "25000000" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /At least 60 GiB/u)
    assert.equal(result.stdout, "")
  } finally { f.dispose() }
})

test("a cached image allows a repeat VM test without budgeting for its download twice", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_AVAILABLE: "40000000", FIXTURE_CACHED_IMAGE: "ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /VM smoke test passed/u)
  } finally { f.dispose() }
})

test("an unrelated cached image does not lower the disk-space requirement", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_AVAILABLE: "40000000", FIXTURE_CACHED_IMAGE: "ghcr.io/cirruslabs/macos-tahoe-base:latest" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /At least 60 GiB/u)
    assert.equal(f.commands().some(line => line.startsWith("clone ")), false)
  } finally { f.dispose() }
})

test("a cached image still requires room for the clone and installations", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_AVAILABLE: "25000000", FIXTURE_CACHED_IMAGE: "ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /At least 30 GiB/u)
    assert.equal(f.commands().some(line => line.startsWith("clone ")), false)
  } finally { f.dispose() }
})

test("an explicitly supplied public CA bundle is copied into the read-only guest input", () => {
  const f = fixture()
  try {
    const certificate = join(f.root, "network-ca.pem")
    execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-subj", "/CN=VM Test CA", "-days", "1", "-keyout", join(f.root, "test-key.pem"), "-out", certificate],
    { stdio: "ignore", timeout: 10_000 })
    const result = f.run({}, ["--local", "--attended", "--ca-bundle", certificate])
    assert.equal(result.status, 0, result.stderr)
    const results = /Results: (.+)/u.exec(result.stdout)![1]
    assert.equal(readFileSync(join(results, "../input/network-ca.pem"), "utf8"), readFileSync(certificate, "utf8"))
  } finally { f.dispose() }
})

test("unreadable, invalid, and private-key CA inputs fail before starting a VM", () => {
  const f = fixture()
  try {
    const invalid = join(f.root, "invalid.pem")
    writeFileSync(invalid, "not a certificate\n")
    const privateKey = join(f.root, "private.pem")
    writeFileSync(privateKey, "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n")
    for (const [path, message] of [
      [join(f.root, "missing.pem"), /readable PEM/u],
      [invalid, /PEM certificates/u],
      [privateKey, /must not contain private keys/u]
    ] as const) {
      const result = f.run({}, ["--local", "--attended", "--ca-bundle", path])
      assert.equal(result.status, 1)
      assert.match(result.stderr, message)
      assert.equal(result.stdout, "")
    }
  } finally { f.dispose() }
})


test("unattended VM driver connects its UI controller for both boots", () => {
  const f = fixture()
  try {
    const result = f.run({}, ["--local"])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(f.commands().filter(line => line.startsWith("run ")).every(line => line.includes("--no-graphics --vnc-experimental")))
    const ui = f.commands().filter(line => line.startsWith("ui "))
    assert.equal(ui.length, 2)
    assert.ok(f.commands().some(line => line.startsWith("ssh ") && line.includes("IdentityAgent=none") && line.includes("PubkeyAuthentication=no") && line.includes("open -a Terminal")))
    assert.ok(ui.every(line => line.includes("--results")))
  } finally { f.dispose() }
})

test("failed UI automation stops and preserves its VM", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_UI_FAIL: "true" }, ["--local"])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /VM preserved for inspection/u)
    assert.equal(f.commands().some(line => line.startsWith("delete ")), false)
  } finally { f.dispose() }
})


test("an interrupted VM test stops its process and preserves its clone", { timeout: 15000 }, async t => {
  const f = fixture()
  t.after(f.dispose)
  const child = f.start()
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
  let stdout = "", stderr = "", interrupted = false
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  const closed = once(child, "close")
  child.stdout.on("data", chunk => {
    stdout += String(chunk)
    if (!interrupted && stdout.includes("Results:")) { interrupted = true; child.kill("SIGTERM") }
  })
  const [code] = await closed
  assert.equal(code, 143, stderr)
  assert.match(stderr, /VM preserved for inspection/u)
  assert.equal(f.commands().filter(line => line.startsWith("stop ")).length, 1)
  assert.equal(f.commands().some(line => line.startsWith("delete ")), false)
})

test("an unexpected VM exit fails the stage and retains its clone", () => {
  const f = fixture()
  try {
    const result = f.run({ FIXTURE_RUN_FAIL: "true" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /exited before the test finished/u)
    assert.match(result.stderr, /VM preserved for inspection/u)
    assert.equal(f.commands().some(line => line.startsWith("delete ")), false)
  } finally { f.dispose() }
})
