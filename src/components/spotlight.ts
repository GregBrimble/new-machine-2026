import { readFileSync } from "node:fs"
import { absolutePaths } from "../machine.ts"
import type { Machine } from "../machine.ts"
import { developerDirectory } from "./developer.ts"
import { Effect } from "effect"
import type { Component, Observation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

const spotlightScript = readFileSync(new URL("./spotlight.applescript", import.meta.url), "utf8")
export const settings = (machine: Machine) => [developerDirectory(machine), "/opt/homebrew"]

export function spotlight(system: System, folders: ReadonlyArray<string>): Component {
  for (const path of folders) {
    absolutePaths(path)
    if (/^\/+$/u.test(path)) throw new Error(`Invalid Spotlight folder: ${path}`)
  }
  return {
    id: "spotlight", description: `Ensure Search Privacy exclusions: ${folders.join(", ") || "none"}`,
    inspect: () => Effect.succeed(folders.length === 0
      ? { status: "ok", detail: "No folders configured" }
      : { status: "unknown", detail: "Folder exclusions cannot be queried reliably; ensure them through Search Privacy (macOS deduplicates by path)" }),
    apply: () => Effect.gen(function* () {
      const paths: string[] = []
      for (const path of folders) {
        yield* system.mkdir(path)
        const resolved = yield* system.realpath(path)
        if (resolved === "/") return yield* Effect.fail(new BootstrapError("Spotlight", `Folder resolves to filesystem root: ${path}`))
        paths.push(resolved)
      }
      if (paths.length) yield* checked(system, { file: "osascript", args: ["-", ...new Set(paths)], input: spotlightScript, interactive: true })
    }),
    // The AppleScript checks that each picker submission is accepted, then closes the dialog.
    // There is no independent, supported folder-level query for these exclusions.
    verify: () => Effect.void
  }
}
