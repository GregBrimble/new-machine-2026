import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import type { Component } from "../runner.ts"
import { checked } from "../system.ts"
import type { System } from "../system.ts"

export interface Downloads { directory: string; olderThanDays: number; checkIntervalHours: number; helperPath: string; launchAgentPath: string; logPath: string }
export const settings = ({ home }: Machine): Downloads => ({
  directory: join(home, "Downloads"), olderThanDays: 30, checkIntervalHours: 24,
  helperPath: join(home, "Library/Application Support/new-machine-2026/downloads-cleanup"),
  launchAgentPath: join(home, "Library/LaunchAgents/com.gregbrimble.new-machine-2026.downloads-cleanup.plist"),
  logPath: join(home, "Library/Logs/new-machine-2026-downloads-cleanup.log")
})

const source = readFileSync(new URL("./downloads-helper.m", import.meta.url), "utf8")

export function downloadsCleanup(system: System, config: Downloads): Component {
  absolutePaths(config.directory, config.helperPath, config.launchAgentPath, config.logPath)
  if (join(config.directory) === "/") throw new Error("Downloads cleanup cannot target the filesystem root.")
  if (!Number.isSafeInteger(config.olderThanDays) || config.olderThanDays <= 0) throw new Error("Downloads cleanup age must be a positive whole number of days.")
  if (!Number.isSafeInteger(config.checkIntervalHours * 3600) || config.checkIntervalHours < 1) throw new Error("Downloads cleanup interval must be at least one hour and resolve to a safe whole number of seconds.")
  const age = `+${config.olderThanDays}d`
  const label = "com.gregbrimble.new-machine-2026.downloads-cleanup"
  const sourcePath = `${config.helperPath}.m`, nextPath = `${config.helperPath}.next`, markerPath = `${config.helperPath}.sha256`
  const compilerArgs = ["clang", "-fobjc-arc", "-O2", "-framework", "Foundation", sourcePath, "-o", nextPath]
  const fingerprint = createHash("sha256").update(source).update(process.arch).update(JSON.stringify(compilerArgs)).digest("hex") + "\n"
  const compiled = () => Effect.gen(function* () {
    return (yield* system.readText(markerPath)) === fingerprint && (yield* system.executable(config.helperPath))
  })
  const args = [
    config.helperPath, label, String(config.checkIntervalHours * 3600),
    "/usr/bin/find", "-P", config.directory, "-maxdepth", "1", "-type", "f",
    "-Btime", age, "-mtime", age, "-ctime", age,
    "!", "-name", ".*", "!", "-name", "*.download", "!", "-name", "*.crdownload", "!", "-name", "*.part",
    "-exec", "/usr/bin/trash", "--verbose", "{}", "+"
  ]
  const plist = checked(system, {
    file: "/usr/bin/plutil", args: ["-convert", "xml1", "-o", "-", "--", "-"],
    input: JSON.stringify({ Label: label, ProgramArguments: args, KeepAlive: true, ProcessType: "Background", StandardOutPath: config.logPath, StandardErrorPath: config.logPath })
  }).pipe(Effect.map(text => `${text}\n`))
  const description = `Use macOS background activity to trash files in ${config.directory} older than ${config.olderThanDays} days (suggested interval: ${config.checkIntervalHours} hours)`
  const inspect = () => Effect.gen(function* () {
    const current = yield* system.readText(config.launchAgentPath)
    return { status: current === (yield* plist) && (yield* compiled()) ? "ok" as const : "change" as const, detail: description }
  })
  return {
    id: "downloads-cleanup", description, inspect,
    apply: () => Effect.gen(function* () {
      if (!(yield* compiled())) {
        yield* system.writeText(sourcePath, source)
        yield* checked(system, { file: "/usr/bin/xcrun", args: compilerArgs })
        yield* checked(system, { file: nextPath, args: ["--help"] })
        yield* checked(system, { file: "/bin/mv", args: ["-f", nextPath, config.helperPath] })
        yield* system.writeText(markerPath, fingerprint)
      }
      yield* system.mkdir(dirname(config.logPath))
      const desired = yield* plist
      if ((yield* system.readText(config.launchAgentPath)) !== desired) yield* system.writeText(config.launchAgentPath, desired)
    })
  }
}
