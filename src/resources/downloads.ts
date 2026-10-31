import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect } from "effect"
import type { Configuration } from "../config.ts"
import type { Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import { checked } from "../system.ts"
import type { System } from "../system.ts"

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const source = readFileSync(new URL("./downloads-helper.m", import.meta.url), "utf8")

export function downloadsCleanup(system: System, config: Configuration["downloadsCleanup"]): Resource {
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
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(config.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(config.logPath)}</string>
</dict>
</plist>
`
  const description = `Use macOS background activity to trash files in ${config.directory} older than ${config.olderThanDays} days (suggested interval: ${config.checkIntervalHours} hours)`
  const inspect = () => Effect.gen(function* () {
    const current = yield* system.readText(config.launchAgentPath)
    return { status: current === plist && (yield* compiled()) ? "ok" as const : "change" as const, detail: description }
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
      if ((yield* system.readText(config.launchAgentPath)) !== plist) yield* system.writeText(config.launchAgentPath, plist)
    }),
    verify: () => verifyObservation("downloads-cleanup", inspect)
  }
}
