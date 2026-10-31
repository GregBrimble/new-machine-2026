import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const script = join(repo, "vm/run.sh")

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
  run)
    for arg in "$@"; do
      case "$arg" in --dir=bootstrap-results:*) output="\${arg#--dir=bootstrap-results:}" ;; esac
    done
    echo $$ > "$FIXTURE_ROOT/vm-pid"
    if [[ ! -f "$FIXTURE_ROOT/first-boot" ]]; then
      touch "$FIXTURE_ROOT/first-boot"
      printf '%s\\n' "\${FIXTURE_FIRST_STATUS:-reboot-required}" > "$output/status"
    else
      echo passed > "$output/status"
    fi
    trap 'exit 0' TERM
    while :; do sleep 0.1; done ;;
  stop) kill "$(cat "$FIXTURE_ROOT/vm-pid")" ;;
  *) exit 97 ;;
esac`)
  const run = (extra: Record<string, string> = {}, args: string[] = ["--local"]) => spawnSync("/bin/bash", [script, ...args], {
    cwd: repo, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: root,
      FIXTURE_ROOT: root, FIXTURE_LOG: log, ...extra }
  })
  return { root, run, commands: () => readFileSync(log, "utf8").trim().split("\n"),
    dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test("VM driver restarts its own disposable clone and deletes it only after success", () => {
  const f = fixture()
  try {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const commands = f.commands()
    const clone = commands.find(line => line.startsWith("clone "))!
    assert.ok(clone.includes("macos-tahoe-vanilla:latest"))
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
    const result = f.run({ FIXTURE_AVAILABLE: "40000000", FIXTURE_CACHED_IMAGE: "ghcr.io/cirruslabs/macos-tahoe-vanilla:latest" })
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
    const result = f.run({ FIXTURE_AVAILABLE: "25000000", FIXTURE_CACHED_IMAGE: "ghcr.io/cirruslabs/macos-tahoe-vanilla:latest" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /At least 30 GiB/u)
    assert.equal(f.commands().some(line => line.startsWith("clone ")), false)
  } finally { f.dispose() }
})
