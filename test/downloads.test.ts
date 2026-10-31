import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { configuration, validateConfiguration } from "../src/config.ts"
import { downloadsCleanup } from "../src/resources/downloads.ts"
import { reconcile } from "../src/runner.ts"
import { BootstrapError, liveSystem } from "../src/system.ts"
import type { Command, System } from "../src/system.ts"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "new-machine-downloads-"))
  const config = configuration(join(root, "home & <test>"), root, "shared").downloadsCleanup
  const native = liveSystem(process.env)
  const writes: string[] = []
  const commands: Command[] = []
  const system: System = {
    ...native,
    run: command => {
      commands.push(command)
      return ["/usr/bin/xcrun", "/bin/mv", `${config.helperPath}.next`].includes(command.file)
        ? native.run(command)
        : Effect.fail(new BootstrapError("test", `Unexpected installation command: ${command.file}`))
    },
    writeText: (path, text) => { writes.push(path); return native.writeText(path, text) }
  }
  const run = (mode: "apply" | "plan" | "preview" = "apply") =>
    Effect.runPromise(reconcile([downloadsCleanup(system, config)], mode, () => {}))
  const job = () => {
    const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", config.launchAgentPath], { encoding: "utf8" })
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout)
    return JSON.parse(parsed.stdout) as { Label: string; ProgramArguments: string[]; KeepAlive: boolean; ProcessType: string; StandardOutPath: string; StandardErrorPath: string }
  }
  return { root, config, native, system, writes, commands, run, job, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test("Downloads cleanup installs a valid background LaunchAgent, converges, and updates its age", async () => {
  const f = fixture()
  try {
    await f.run("preview"); await f.run("plan")
    assert.deepEqual(f.writes, [])
    await f.run()
    const job = f.job()
    assert.equal(job.KeepAlive, true)
    assert.equal(job.ProcessType, "Background")
    assert.deepEqual(job.ProgramArguments.slice(0, 4), [f.config.helperPath, job.Label, "86400", "/usr/bin/find"])
    assert.ok(job.ProgramArguments.includes(f.config.directory))
    assert.equal(job.ProgramArguments.filter(arg => arg === "+30d").length, 3)
    assert.equal(job.StandardOutPath, f.config.logPath)
    assert.equal(job.StandardErrorPath, f.config.logPath)
    assert.ok(existsSync(join(f.config.logPath, "..")))
    f.writes.length = 0; f.commands.length = 0
    await f.run()
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.commands, [])
    f.config.olderThanDays = 45
    f.config.checkIntervalHours = 6
    await f.run()
    assert.equal(f.job().ProgramArguments.filter(arg => arg === "+45d").length, 3)
    assert.equal(f.job().ProgramArguments[2], "21600")
    assert.deepEqual(f.commands, [])
  } finally { f.dispose() }
})

test("native find selects aged top-level files, preserves recent and excluded items, and propagates Trash failures", async () => {
  const f = fixture()
  try {
    await f.run()
    mkdirSync(f.config.directory, { recursive: true })
    const trash = join(f.root, "test Trash"), stub = join(f.root, "trash stub")
    mkdirSync(trash)
    writeFileSync(stub, '#!/bin/sh\n[ "$1" = "--verbose" ] || exit 9\n[ "${TRASH_FIXTURE_FAIL:-0}" = 0 ] || exit 7\nshift\nfor item do\n  /bin/mv "$item" "$TRASH_FIXTURE/" || exit\ndone\n')
    chmodSync(stub, 0o755)
    const oldName = "-old file with 'quotes' &\nnewlines.txt"
    const retained = [".hidden", "unfinished.download", "unfinished.crdownload", "unfinished.part", "recently modified", "recent metadata"]
    for (const name of [oldName, ...retained]) writeFileSync(join(f.config.directory, name), "contents")
    const folder = join(f.config.directory, "old folder")
    mkdirSync(folder); writeFileSync(join(folder, "nested file"), "keep")
    const outside = join(f.root, "outside file")
    writeFileSync(outside, "keep")
    symlinkSync(outside, join(f.config.directory, "link"))
    // Exercise the same native age predicates in seconds rather than waiting days.
    await new Promise(resolve => setTimeout(resolve, 3200))
    writeFileSync(join(f.config.directory, "recently modified"), "updated")
    chmodSync(join(f.config.directory, "recent metadata"), 0o640)
    const fresh = join(f.config.directory, "fresh download with old modification date")
    writeFileSync(fresh, "new")
    utimesSync(fresh, new Date(0), new Date(0))
    const args = ["--once", ...f.job().ProgramArguments.slice(3).map(arg => arg === "+30d" ? "+2s" : arg === "/usr/bin/trash" ? stub : arg)]
    const env = { PATH: "/usr/bin:/bin", TRASH_FIXTURE: trash }
    const failed = spawnSync(f.config.helperPath, args, { encoding: "utf8", env: { ...env, TRASH_FIXTURE_FAIL: "1" } })
    assert.notEqual(failed.status, 0)
    assert.ok(existsSync(join(f.config.directory, oldName)))
    const result = spawnSync(f.config.helperPath, args, { encoding: "utf8", env })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(trash), [oldName])
    for (const name of retained) assert.ok(existsSync(join(f.config.directory, name)), name)
    assert.ok(existsSync(fresh))
    assert.ok(existsSync(join(folder, "nested file")))
    assert.ok(lstatSync(join(f.config.directory, "link")).isSymbolicLink())
    assert.ok(existsSync(outside))
  } finally { f.dispose() }
})

test("an ineffective LaunchAgent write fails verification", async () => {
  const f = fixture()
  try {
    await f.run()
    rmSync(f.config.launchAgentPath)
    const system = { ...f.system, writeText: () => Effect.void }
    await assert.rejects(Effect.runPromise(reconcile([downloadsCleanup(system, f.config)], "apply", () => {})), /Verification failed/u)
  } finally { f.dispose() }
})

test("Downloads cleanup validates its age and paths", () => {
  for (const olderThanDays of [0, -1, 1.5, Infinity, NaN]) {
    const config = configuration("/Users/test", "/Users/test", "shared")
    config.downloadsCleanup.olderThanDays = olderThanDays
    assert.throws(() => validateConfiguration(config), /whole number of days/u)
  }
  for (const directory of ["relative", "/", "/tmp/.."]) {
    const config = configuration("/Users/test", "/Users/test", "shared")
    config.downloadsCleanup.directory = directory
    assert.throws(() => validateConfiguration(config), /absolute|filesystem root/u)
  }
  for (const checkIntervalHours of [0, -1, Infinity, NaN]) {
    const config = configuration("/Users/test", "/Users/test", "shared")
    config.downloadsCleanup.checkIntervalHours = checkIntervalHours
    assert.throws(() => validateConfiguration(config), /interval/u)
  }
})

test("a failed native rebuild preserves the working helper and remains retryable", async () => {
  const f = fixture()
  try {
    await f.run()
    writeFileSync(`${f.config.helperPath}.sha256`, "outdated build\n")
    let attempts = 0
    const system: System = { ...f.system, run: command => {
      if (command.file !== "/usr/bin/xcrun") return f.system.run(command)
      attempts++
      return Effect.succeed({ code: 1, stdout: "", stderr: "Compiler unavailable" })
    } }
    for (let run = 0; run < 2; run++) {
      await assert.rejects(Effect.runPromise(reconcile([downloadsCleanup(system, f.config)], "apply", () => {})), /Compiler unavailable/u)
      const help = spawnSync(f.config.helperPath, ["--help"], { encoding: "utf8" })
      assert.equal(help.status, 0, help.stderr)
    }
    assert.equal(attempts, 2)
    await f.run()
    assert.equal((await Effect.runPromise(downloadsCleanup(f.system, f.config).inspect())).status, "ok")
  } finally { f.dispose() }
})

test("the native helper registers a macOS background activity and stays alive", async () => {
  const f = fixture()
  let child: ReturnType<typeof spawn> | undefined
  try {
    await f.run()
    child = spawn(f.config.helperPath, [`com.gregbrimble.new-machine-2026.test.${randomUUID()}`, "86400", "/usr/bin/false"], { stdio: ["ignore", "pipe", "pipe"] })
    const running = child
    let output = ""
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Scheduler did not start: ${output}`)), 5000)
      running.once("error", error => { clearTimeout(timeout); reject(error) })
      running.once("exit", code => { clearTimeout(timeout); reject(new Error(`Scheduler exited with ${code}: ${output}`)) })
      running.stderr!.on("data", chunk => {
        output += String(chunk)
        if (output.includes("Scheduled cleanup with macOS")) { clearTimeout(timeout); resolve() }
      })
    })
    assert.equal(running.exitCode, null)
    const ended = once(running, "exit")
    running.kill("SIGTERM")
    await ended
    child = undefined
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit")
      child.kill("SIGKILL"); await ended
    }
    f.dispose()
  }
})
