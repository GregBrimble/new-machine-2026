import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repo = fileURLToPath(new URL("../", import.meta.url))
const nodeVersion = readFileSync(join(repo, ".node-version"), "utf8").trim()

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "new-machine-loader-")))
  const bin = join(root, "bin"), home = join(root, "home with spaces"), temp = join(root, "tmp"), project = join(root, "source")
  const brew = join(root, "arm-prefix/bin/brew"), prefix = join(root, "opt/mise")
  for (const path of [bin, home, temp, join(project, "src")]) mkdirSync(path, { recursive: true })
  const log = join(root, "events")
  const executable = (path: string, script: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\nset -eu\n${script}\n`); chmodSync(path, 0o755)
  }
  // Model the standard Homebrew locations independently of the test host.
  const source = readFileSync(join(repo, "bootstrap.sh"), "utf8")
    .replaceAll("/opt/homebrew/bin/brew", brew)
    .replaceAll("/usr/local/bin/brew", join(root, "intel-prefix/bin/brew"))
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
  printf 'runner-mise:%s\\nrunner-brew:%s\\n' "$BOOTSTRAP_MISE_BIN" "$BOOTSTRAP_BREW_BIN" >> "$FIXTURE_LOG"
  if [ "\${FIXTURE_RUNNER_JSON:-0}" = 1 ]; then printf '{"type":"fixture"}\\n'; fi
fi`)
  const brewTemplate = join(root, "brew-fixture")
  executable(brewTemplate, `
printf 'brew:%s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
  --version) printf 'Homebrew fixture\\n' ;;
  shellenv)
    [ "\${FIXTURE_SHELLENV_FAIL:-0}" = 0 ] || exit 78
    printf 'export PATH="%s:%s:$PATH"\\n' "$(dirname "$FIXTURE_BREW_DEST")" "$FIXTURE_BIN" ;;
  --prefix) [ "$2" = mise ] || exit 94; printf '%s\\n' "$FIXTURE_PREFIX" ;;
  list)
    [ "$2" = --formula ] && [ "$3" = --versions ] && [ "$#" = 3 ] || exit 95
    [ "\${FIXTURE_LIST_FAIL:-0}" = 0 ] || exit 77
    if [ -f "$FIXTURE_ROOT/mise-recorded" ]; then printf 'mise fixture-version\\n'; fi ;;
  install|reinstall)
    [ "$2" = mise ] || exit 96
    [ "\${FIXTURE_MISE_INSTALL_FAIL:-0}" = 0 ] || exit 74
    touch "$FIXTURE_ROOT/mise-recorded"
    [ "\${FIXTURE_MISE_INEFFECTIVE:-0}" = 0 ] || exit 0
    mkdir -p "$FIXTURE_PREFIX/bin" "$FIXTURE_PREFIX/share/zsh/site-functions"
    cp "$FIXTURE_MISE" "$FIXTURE_PREFIX/bin/mise"
    chmod +x "$FIXTURE_PREFIX/bin/mise"
    printf '#compdef mise\\n' > "$FIXTURE_PREFIX/share/zsh/site-functions/_mise" ;;
  *) exit 97 ;;
esac`)
  executable(join(bin, "uname"), 'printf "Darwin\\n"')
  executable(join(bin, "id"), 'printf "501\\n"')
  const installer = join(root, "installer.sh")
  executable(installer, `
printf 'install-homebrew\\n' >> "$FIXTURE_LOG"
[ "\${FIXTURE_BREW_INSTALL_FAIL:-0}" = 0 ] || exit 73
[ "\${FIXTURE_BREW_INEFFECTIVE:-0}" = 0 ] || exit 0
mkdir -p "$(dirname "$FIXTURE_BREW_DEST")"
cp "$FIXTURE_BREW" "$FIXTURE_BREW_DEST"
chmod +x "$FIXTURE_BREW_DEST"`)
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
  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) cp "$FIXTURE_INSTALLER" "$output" ;;
  https://codeload.github.com/GregBrimble/new-machine-2026/tar.gz/main) cp "$FIXTURE_ARCHIVE" "$output" ;;
  *) exit 93 ;;
esac`)
  const env = {
    HOME: home, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, FIXTURE_LOG: log,
    FIXTURE_ROOT: root, FIXTURE_BIN: bin, FIXTURE_MISE: mise, FIXTURE_BREW: brewTemplate,
    FIXTURE_BREW_DEST: brew, FIXTURE_PREFIX: prefix, FIXTURE_INSTALLER: installer, FIXTURE_ARCHIVE: archive
  }
  const installBrew = () => { mkdirSync(dirname(brew), { recursive: true }); cpSync(brewTemplate, brew) }
  const installMise = () => {
    mkdirSync(join(prefix, "bin"), { recursive: true }); cpSync(mise, join(prefix, "bin/mise"))
    mkdirSync(join(prefix, "share/zsh/site-functions"), { recursive: true })
    writeFileSync(join(prefix, "share/zsh/site-functions/_mise"), "#compdef mise\n")
    writeFileSync(join(root, "mise-recorded"), "")
  }
  const events = () => existsSync(log) ? readFileSync(log, "utf8") : ""
  const run = (args: string[] = [], extra: Record<string, string> = {}, piped = false) => spawnSync(
    "/bin/bash", piped ? ["-s", "--", ...args] : [script, ...args],
    { encoding: "utf8", env: { ...env, ...extra }, cwd: root, input: piped ? source : undefined }
  )
  return { root, bin, home, temp, project, prefix, brew, run, events, installBrew, installMise, executable,
    dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test("a curl-piped fresh bootstrap prepares Homebrew, Homebrew mise, Node, and the runner in order", () => {
  const f = fixture()
  try {
    const result = f.run(["--dry-run", "--profile", "cloudflare"], {}, true)
    assert.equal(result.status, 0, result.stderr)
    const events = f.events()
    assert.match(events, /install-homebrew/u)
    assert.match(events, /brew:install mise/u)
    assert.match(events, /-- npm ci --omit=dev --ignore-scripts/u)
    assert.match(events, /runner:node src\/main.ts --dry-run --profile cloudflare/u)
    assert.ok(events.indexOf("install-homebrew") < events.indexOf("brew:install mise"))
    assert.ok(events.indexOf("brew:install mise") < events.indexOf("-- node --version"))
    assert.ok(events.indexOf("-- npm ci") < events.indexOf("runner:"))
    assert.ok(events.includes(`runner-mise:${f.prefix}/bin/mise\nrunner-brew:${f.brew}`))
    assert.deepEqual(readdirSync(f.temp), [])
  } finally { f.dispose() }
})

test("existing Homebrew and its mise are reused, including when brew starts outside PATH", () => {
  const f = fixture()
  try {
    f.installBrew(); f.installMise()
    assert.equal(f.run(["--dry-run"]).status, 0)
    const before = f.events()
    const second = f.run(["--dry-run"])
    assert.equal(second.status, 0, second.stderr)
    assert.doesNotMatch(f.events(), /install-homebrew|brew:install |brew:reinstall /u)
    assert.doesNotMatch(f.events().slice(before.length), /npm ci|curl:/u)
    assert.match(f.events().slice(before.length), /runner:/u)
    assert.deepEqual(readdirSync(f.temp), [])
  } finally { f.dispose() }
})

test("structured status keeps prerequisite output on stderr and forwards the selected component", () => {
  const f = fixture()
  try {
    const result = f.run(["--status", "--json", "--component", "appearance"], { FIXTURE_RUNNER_JSON: "1" }, true)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split("\n").map(line => JSON.parse(line)), [{ type: "fixture" }])
    assert.match(result.stderr, /Homebrew fixture/u)
    assert.match(f.events(), /runner:node src\/main.ts --status --json --component appearance/u)
  } finally { f.dispose() }
})

test("a standalone mise on PATH does not replace the Homebrew-managed prerequisite", () => {
  const f = fixture()
  try {
    f.installBrew()
    f.executable(join(f.bin, "mise"), "exit 89")
    const result = f.run(["--dry-run"])
    assert.equal(result.status, 0, result.stderr)
    assert.match(f.events(), /brew:install mise/u)
    assert.ok(f.events().includes(`runner-mise:${f.prefix}/bin/mise`))
  } finally { f.dispose() }
})

test("the stable opt path is kept when the mise formula is a symlink to a versioned cellar", () => {
  const f = fixture()
  try {
    f.installBrew()
    const cellar = join(f.root, "Cellar/mise/version")
    mkdirSync(cellar, { recursive: true }); mkdirSync(dirname(f.prefix), { recursive: true })
    symlinkSync(cellar, f.prefix)
    f.installMise()
    const result = f.run(["--dry-run"])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(f.events().includes(`runner-mise:${f.prefix}/bin/mise`))
  } finally { f.dispose() }
})

for (const missing of ["bin/mise", "share/zsh/site-functions/_mise"]) {
  test(`a recorded formula missing ${missing} is repaired`, () => {
    const f = fixture()
    try {
      f.installBrew(); f.installMise(); rmSync(join(f.prefix, missing))
      const result = f.run(["--dry-run"])
      assert.equal(result.status, 0, result.stderr)
      assert.match(f.events(), /brew:reinstall mise/u)
    } finally { f.dispose() }
  })
}

test("dependency lock changes trigger reinstall", () => {
  const f = fixture()
  try {
    f.installBrew(); f.installMise()
    assert.equal(f.run(["--dry-run"]).status, 0)
    const before = f.events(), lock = join(f.project, "package-lock.json")
    writeFileSync(lock, `${readFileSync(lock, "utf8")}\n`)
    assert.equal(f.run(["--dry-run"]).status, 0)
    assert.match(f.events().slice(before.length), /npm ci/u)
  } finally { f.dispose() }
})

for (const [flag, expected] of [
  ["FIXTURE_CURL_FAIL", 22], ["FIXTURE_BREW_INSTALL_FAIL", 73], ["FIXTURE_BREW_INEFFECTIVE", 1],
  ["FIXTURE_SHELLENV_FAIL", 78], ["FIXTURE_LIST_FAIL", 77], ["FIXTURE_MISE_INSTALL_FAIL", 74],
  ["FIXTURE_MISE_INEFFECTIVE", 1], ["FIXTURE_NODE_FAIL", 72], ["FIXTURE_NPM_FAIL", 71]
] as const) {
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
    for (const args of [["--unknown"], ["--profile"], ["--profile", "invalid"], ["--dry-run", "--plan"], ["--component"], ["--component", "--json"], ["--status", "--plan"]]) assert.equal(f.run(args).status, 1)
    assert.equal(f.events(), "")
    assert.deepEqual(readdirSync(f.temp), [])
  } finally { f.dispose() }
})
