import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { configuration } from "../src/config.ts"

const run = (file: string, args: string[] = [], input?: string) => execFileSync(file, args, { encoding: "utf8", timeout: 60_000, input, stdio: ["pipe", "pipe", "pipe"] }).trim()
assert.match(run("/usr/sbin/sysctl", ["-n", "hw.model"]), /^VirtualMac/u, "VM-only test")
assert.notEqual(process.getuid?.(), 0)
const [stage, results] = process.argv.slice(2)
assert.ok(stage === "first" || stage === "repeat" || stage === "after-login")
assert.ok(results)
const home = homedir()
const zshDirectory = run("/bin/zsh", ["-c", 'builtin printf "%s" "${ZDOTDIR-$HOME}"'])
const config = configuration(home, zshDirectory, "shared")
const brew = "/opt/homebrew/bin/brew"
const mise = "/opt/homebrew/opt/mise/bin/mise"
const pin = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim()
assert.equal(process.version, `v${pin}`)
assert.equal(run(brew, ["--prefix", "mise"]), "/opt/homebrew/opt/mise")
assert.ok(statSync(mise).isFile())
assert.equal(run("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"]), "Dark")
const automatic = spawnSync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyleSwitchesAutomatically"], { encoding: "utf8", timeout: 60_000 })
if (automatic.status === 0) assert.equal(automatic.stdout.trim(), "0")
else {
  assert.equal(automatic.status, 1, automatic.stderr)
  assert.match(automatic.stderr, /does not exist|not found/iu, "An absent key means automatic switching is off")
}
assert.equal(run("/usr/bin/defaults", ["read", "com.apple.finder", "FXRemoveOldTrashItems"]), "1")
assert.equal(run("/usr/bin/git", ["config", "--global", "--type=bool", "--get", "push.autoSetupRemote"]), "true")
for (const name of ["repos", "worktrees", "tries"]) assert.ok(statSync(join(config.developerDirectory, name)).isDirectory())
run(brew, ["bundle", "check", "--no-upgrade", "--file=-"], config.casks.map(name => `cask "${name}"\n`).join(""))
for (const app of ["Ghostty", "Spotify", "VLC", "Google Chrome"]) {
  assert.ok(statSync(`/Applications/${app}.app/Contents/Info.plist`).isFile(), `${app} is installed`)
}
const vlc = readFileSync(config.vlc.configPath, "utf8")
assert.match(vlc, /^rate=2\.35\r?$/mu)
assert.match(vlc, /^sub-language=en,any\r?$/mu)
assert.equal(run("/bin/zsh", ["-lic", [
  '[[ "$(whence -p brew)" == /opt/homebrew/bin/brew ]] || exit 20',
  '[[ -x "$(whence -p mise)" ]] && (( $+functions[mise] )) || exit 21',
  '[[ "${_comps[mise]}" == _mise ]] || exit 22',
  "node --version"
].join("\n")]), `v${pin}`)

const files = [config.homebrewProfile, config.miseProfile, join(home, ".gitconfig"),
  config.vlc.configPath, config.downloadsCleanup.launchAgentPath,
  config.downloadsCleanup.helperPath, `${config.downloadsCleanup.helperPath}.m`, `${config.downloadsCleanup.helperPath}.sha256`]
const snapshot = {
  files: Object.fromEntries(files.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
  formulae: run(brew, ["list", "--formula", "--versions"]).split("\n").sort(),
  casks: run(brew, ["list", "--cask", "--versions"]).split("\n").sort()
}
if (stage === "first") writeFileSync(join(results, "before.json"), JSON.stringify(snapshot, null, 2))
else assert.deepEqual(snapshot, JSON.parse(readFileSync(join(results, "before.json"), "utf8")), "Repeat application/login preserves files and package versions")
if (stage === "repeat") {
  const applied = readFileSync(join(results, "bootstrap-repeat.log"), "utf8")
    .split("\n").filter(line => line.startsWith("[applied] "))
  // Search Privacy cannot be inspected through a supported CLI; it is ensured again.
  assert.deepEqual(applied, ["[applied] spotlight"])
}
console.log(`PASS: ${stage} configuration, applications, login zsh, and file/package snapshot`)

if (stage === "after-login") {
  const label = "com.gregbrimble.new-machine-2026.downloads-cleanup"
  let running = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      running = /state = running/u.test(run("/bin/launchctl", ["print", `gui/${process.getuid!()}/${label}`])) &&
        existsSync(config.downloadsCleanup.logPath) && /Scheduled cleanup with macOS/u.test(readFileSync(config.downloadsCleanup.logPath, "utf8"))
    } catch { /* Login may still be starting agents. */ }
    if (running) break
    await setTimeout(1000)
  }
  assert.ok(running, "The production Downloads helper starts at login")
  assert.match(readFileSync(config.downloadsCleanup.logPath, "utf8"), /Scheduled cleanup with macOS/u)

  // Exercise the installed binary through launchd, including its real Downloads
  // permission, without waiting 30 days or matching anything except our fixtures.
  const prefix = `new-machine-vm-${randomUUID()}`
  const aged = join(config.downloadsCleanup.directory, `${prefix}.txt`)
  const partial = join(config.downloadsCleanup.directory, `${prefix}.part`)
  mkdirSync(config.downloadsCleanup.directory, { recursive: true })
  writeFileSync(aged, "VM test: move this fixture to Trash\n")
  writeFileSync(partial, "VM test: preserve this partial download\n")
  await setTimeout(3200)
  const agent = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", config.downloadsCleanup.launchAgentPath])) as { ProgramArguments: string[] }
  const command = agent.ProgramArguments.slice(3).map(arg => arg === `+${config.downloadsCleanup.olderThanDays}d` ? "+2s" : arg)
  assert.equal(command[0], "/usr/bin/find")
  const execIndex = command.indexOf("-exec")
  assert.ok(execIndex > 0)
  command.splice(execIndex, 0, "-name", `${prefix}*`)
  const probeLabel = `${label}.vm-probe`
  const probePath = join(home, "Library/LaunchAgents", `${probeLabel}.plist`)
  const probeLog = join(home, "new-machine-vm-smoke", "downloads-probe.log")
  run("/usr/bin/plutil", ["-convert", "xml1", "-o", probePath, "--", "-"], JSON.stringify({
    Label: probeLabel,
    ProgramArguments: [config.downloadsCleanup.helperPath, "--once", ...command],
    StandardOutPath: probeLog,
    StandardErrorPath: probeLog,
    RunAtLoad: true
  }))
  console.log("Checking Downloads access from a background LaunchAgent. Allow access if macOS asks.")
  try {
    run("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, probePath])
    let finished = false
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = run("/bin/launchctl", ["print", `gui/${process.getuid!()}/${probeLabel}`])
      const exit = /last exit code = (\d+)/u.exec(state)
      if (exit) {
        assert.equal(exit[1], "0", existsSync(probeLog) ? readFileSync(probeLog, "utf8") : state)
        finished = true
        break
      }
      await setTimeout(1000)
    }
    assert.ok(finished, "Background Downloads probe finished within two minutes")
    assert.ok(!existsSync(aged), "The aged fixture moved out of Downloads")
    assert.ok(existsSync(partial), "Partial downloads are preserved")
    console.log("PASS: native helper runs through launchd and trashes an aged Downloads fixture")
  } finally {
    if (existsSync(probeLog)) writeFileSync(join(results, "downloads-probe.log"), readFileSync(probeLog))
    try { run("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${probeLabel}`]) } catch { /* Preserve the original failure. */ }
    rmSync(probePath, { force: true })
  }
}
