import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repo = fileURLToPath(new URL("../", import.meta.url))
const nodeVersion = readFileSync(join(repo, ".node-version"), "utf8").trim()

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "new-machine-loader-"))
  const bin = join(root, "bin"), home = join(root, "home with spaces"), temp = join(root, "tmp"), project = join(root, "source")
  for (const path of [bin, home, temp, join(project, "src")]) mkdirSync(path, { recursive: true })
  const log = join(root, "events")
  const executable = (path: string, script: string) => { writeFileSync(path, `#!/bin/sh\nset -eu\n${script}\n`); chmodSync(path, 0o755) }
  // Model the absolute Homebrew locations inside the fixture, independently of the test host.
  const source = readFileSync(join(repo, "bootstrap.sh"), "utf8")
    .replaceAll("/opt/homebrew/bin/mise", join(root, "arm-prefix/bin/mise"))
    .replaceAll("/usr/local/bin/mise", join(root, "intel-prefix/bin/mise"))
  const script = join(project, "bootstrap.sh"); writeFileSync(script, source)
  for (const file of ["package.json", "package-lock.json", ".node-version"]) cpSync(join(repo, file), join(project, file))
  writeFileSync(join(project, "src/main.ts"), "// Loader fixture; resource behavior is tested separately.\n")
  const mise = join(root, "mise-fixture")
  executable(mise, `
printf 'mise:%s\\n' "$*" >> "$FIXTURE_LOG"
if [ "$1" = --version ]; then printf 'mise fixture\\n'; exit 0; fi
[ "$1" = exec ] && [ "$2" = "node@${nodeVersion}" ] && [ "$3" = -- ] || exit 90
shift 3
if [ "$1" = npm ]; then
  [ "\${FIXTURE_NPM_FAIL:-0}" = 0 ] || exit 71
  mkdir -p node_modules/effect
  printf '{}' > node_modules/effect/package.json
elif [ "$2" = --version ]; then
  [ "\${FIXTURE_NODE_FAIL:-0}" = 0 ] || exit 72
  printf 'v${nodeVersion}\\n'
else
  [ "$1" = node ] && [ "$2" = src/main.ts ] || exit 91
  printf 'runner:%s\\n' "$*" >> "$FIXTURE_LOG"
fi`)
  executable(join(bin, "uname"), 'printf "Darwin\\n"')
  executable(join(bin, "id"), 'printf "501\\n"')
  const installer = join(root, "installer.sh")
  executable(installer, `
printf 'install-mise\\n' >> "$FIXTURE_LOG"
[ "\${MISE_VERSION}" = v2026.10.25 ] || exit 92
[ "\${FIXTURE_INSTALL_FAIL:-0}" = 0 ] || exit 73
mkdir -p "$(dirname "$MISE_INSTALL_PATH")"
cp "$FIXTURE_MISE" "$MISE_INSTALL_PATH"
chmod +x "$MISE_INSTALL_PATH"`)
  const archive = join(root, "source.tar.gz")
  const packed = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", root, "source"], { encoding: "utf8" })
  assert.equal(packed.status, 0, packed.stderr)
  executable(join(bin, "curl"), `
printf 'curl:%s\\n' "$*" >> "$FIXTURE_LOG"
[ "\${FIXTURE_CURL_FAIL:-0}" = 0 ] || exit 22
url='' output=''
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1" ;; --output) shift; output="$1" ;; esac
  shift
done
case "$url" in
  https://mise.run) cp "$FIXTURE_INSTALLER" "$output" ;;
  https://codeload.github.com/GregBrimble/new-machine-2026/tar.gz/main) cp "$FIXTURE_ARCHIVE" "$output" ;;
  *) exit 93 ;;
esac`)
  const env = {
    HOME: home, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    FIXTURE_LOG: log, FIXTURE_MISE: mise, FIXTURE_INSTALLER: installer, FIXTURE_ARCHIVE: archive
  }
  const events = () => existsSync(log) ? readFileSync(log, "utf8") : ""
  const run = (args: string[] = [], extra: Record<string, string> = {}, piped = false) => spawnSync(
    "/bin/bash", piped ? ["-s", "--", ...args] : [script, ...args],
    { encoding: "utf8", env: { ...env, ...extra }, cwd: root, input: piped ? source : undefined }
  )
  return { root, bin, home, temp, project, env, script, mise, run, events, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test("a curl-piped bootstrap with no mise, Node, npm, Git, or Homebrew on PATH prepares everything in order", () => {
  const f = fixture()
  try {
    const result = f.run(["--dry-run", "--profile", "cloudflare"], {}, true)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(join(f.home, ".local/bin/mise")))
    const events = f.events()
    assert.match(events, /install-mise/u)
    assert.match(events, new RegExp(`mise:exec node@${nodeVersion.replaceAll(".", "\\.")} -- node --version`, "u"))
    assert.match(events, /-- npm ci --omit=dev --ignore-scripts/u)
    assert.match(events, /runner:node src\/main.ts --dry-run --profile cloudflare/u)
    assert.ok(events.indexOf("install-mise") < events.indexOf("-- node --version"))
    assert.ok(events.indexOf("-- npm ci") < events.indexOf("runner:"))
    assert.deepEqual(readdirSync(f.temp), [])
  } finally { f.dispose() }
})

test("existing mise and a matching dependency lock are reused on repeated local runs", () => {
  const f = fixture()
  try {
    cpSync(f.mise, join(f.bin, "mise"))
    const first = f.run(["--dry-run"])
    assert.equal(first.status, 0, first.stderr)
    const before = f.events()
    const second = f.run(["--dry-run"])
    assert.equal(second.status, 0, second.stderr)
    const added = f.events().slice(before.length)
    assert.doesNotMatch(f.events(), /install-mise/u)
    assert.doesNotMatch(added, /npm ci|curl:/u)
    assert.match(added, /runner:/u)
    assert.deepEqual(readdirSync(f.temp), [])
  } finally { f.dispose() }
})

test("dependency lock changes trigger reinstall", () => {
  const f = fixture()
  try {
    cpSync(f.mise, join(f.bin, "mise"))
    assert.equal(f.run(["--dry-run"]).status, 0)
    const before = f.events()
    const lock = join(f.project, "package-lock.json")
    writeFileSync(lock, `${readFileSync(lock, "utf8")}\n`)
    assert.equal(f.run(["--dry-run"]).status, 0)
    assert.match(f.events().slice(before.length), /npm ci/u)
  } finally { f.dispose() }
})

for (const [flag, expected] of [["FIXTURE_CURL_FAIL", 22], ["FIXTURE_INSTALL_FAIL", 73], ["FIXTURE_NODE_FAIL", 72], ["FIXTURE_NPM_FAIL", 71]] as const) {
  test(`${flag} stops before starting the runner and cleans temporary downloads`, () => {
    const f = fixture()
    try {
      const result = f.run(["--dry-run"], { [flag]: "1" })
      assert.equal(result.status, expected, result.stderr)
      assert.doesNotMatch(f.events(), /runner:/u)
      assert.deepEqual(readdirSync(f.temp), [])
    } finally { f.dispose() }
  })
}

test("help and invalid arguments need no downloads or runtime", () => {
  const f = fixture()
  try {
    assert.equal(f.run(["--help"]).status, 0)
    for (const args of [["--unknown"], ["--profile"], ["--profile", "invalid"], ["--dry-run", "--plan"]]) {
      assert.equal(f.run(args).status, 1)
    }
    assert.equal(f.events(), "")
    assert.deepEqual(readdirSync(f.temp), [])
    assert.equal(existsSync(join(f.home, ".local")), false)
  } finally { f.dispose() }
})
