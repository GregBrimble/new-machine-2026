import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { Configuration } from "../config.ts"
import type { Observation, Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

const spotlightScript = readFileSync(new URL("./spotlight.applescript", import.meta.url), "utf8")
const quote = (text: string) => /^[a-zA-Z0-9_/.+-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
const observation = (ok: boolean, detail: string): Observation => ({ status: ok ? "ok" : "change", detail })

function findHomebrew(system: System) {
  return Effect.gen(function* () {
    for (const path of system.homebrewCandidates) if (yield* system.executable(path)) return path
    return undefined
  })
}
function requireHomebrew(system: System) {
  return Effect.gen(function* () {
    const path = yield* findHomebrew(system)
    if (!path) return yield* Effect.fail(new BootstrapError("Homebrew", "Executable was not found. Apply the Homebrew resource first."))
    return path
  })
}

function appearance(system: System, desired: Configuration["appearance"]): Resource {
  const read = () => Effect.gen(function* () {
    const dark = yield* checked(system, { file: "osascript", args: ["-e", "tell application \"System Events\" to tell appearance preferences to get dark mode"] })
    const automatic = yield* system.run({ file: "defaults", args: ["read", "-g", "AppleInterfaceStyleSwitchesAutomatically"] })
    if (dark !== "true" && dark !== "false") return yield* Effect.fail(new BootstrapError("Appearance", `Unexpected dark mode value: ${dark}`))
    // defaults returns 1 for an absent key, which means automatic switching is off.
    if (automatic.code !== 0 && !/does not exist|not found/iu.test(automatic.stderr)) {
      return yield* Effect.fail(new BootstrapError("Appearance", automatic.stderr || "Could not read automatic appearance."))
    }
    const auto = automatic.code === 0 ? automatic.stdout.trim() : "0"
    if (auto !== "0" && auto !== "1") return yield* Effect.fail(new BootstrapError("Appearance", `Unexpected automatic appearance value: ${auto}`))
    return { dark: dark === "true", automatic: auto === "1" }
  })
  const inspect = () => Effect.gen(function* () {
    const state = yield* read()
    return observation(state.dark === (desired === "dark") && !state.automatic, `${desired} appearance; automatic switching disabled`)
  })
  return {
    id: "appearance", description: `Ensure ${desired} appearance and disable automatic switching`, inspect,
    apply: () => Effect.gen(function* () {
      const state = yield* read()
      if (state.automatic) yield* checked(system, { file: "defaults", args: ["write", "-g", "AppleInterfaceStyleSwitchesAutomatically", "-bool", "false"] })
      if (state.dark !== (desired === "dark")) yield* checked(system, {
        file: "osascript", args: ["-e", `tell application "System Events" to tell appearance preferences to set dark mode to ${desired === "dark"}`]
      })
    }),
    verify: () => verifyObservation("appearance", inspect)
  }
}

function homebrew(system: System): Resource {
  const inspect = () => Effect.gen(function* () {
    const path = yield* findHomebrew(system)
    if (path) yield* checked(system, { file: path, args: ["--version"] })
    return observation(Boolean(path), path ? `Installed at ${path}` : "Install Homebrew with its official installer")
  })
  return {
    id: "homebrew", description: "Ensure Homebrew is installed", inspect,
    apply: () => Effect.gen(function* () {
      const installer = yield* checked(system, {
        file: "curl", args: ["--fail", "--silent", "--show-error", "--location", "--retry", "2", "--connect-timeout", "15", "--max-time", "300",
          "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"]
      })
      if (!installer) return yield* Effect.fail(new BootstrapError("Homebrew", "Installer download was empty."))
      yield* checked(system, { file: "/bin/bash", args: ["-c", installer], interactive: true })
    }),
    verify: () => verifyObservation("homebrew", inspect)
  }
}

function profileEntry(system: System, id: string, path: string, line: () => Effect.Effect<string | undefined, BootstrapError>): Resource {
  const inspect = () => Effect.gen(function* () {
    const desired = yield* line()
    if (!desired) return { status: "unknown", detail: `Requires Homebrew before checking ${path}` } as const
    const text = (yield* system.readText(path)) ?? ""
    return observation(text.split(/\r?\n/u).includes(desired), `Ensure ${id} in ${path}`)
  })
  return {
    id, description: `Configure ${id} in ${path}`, inspect,
    apply: () => Effect.gen(function* () {
      const desired = yield* line()
      if (!desired) return yield* Effect.fail(new BootstrapError(id, "Homebrew was not found."))
      const text = (yield* system.readText(path)) ?? ""
      if (!text.split(/\r?\n/u).includes(desired)) yield* system.writeText(path, `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n# ${id}\n${desired}\n`)
    }),
    verify: () => verifyObservation(id, inspect)
  }
}

function cask(system: System, config: Configuration, item: Configuration["casks"][number]): Resource {
  const executable = join(config.appDirectory, item.app, item.executable)
  const inspect = () => Effect.gen(function* () {
    return observation(yield* system.executable(executable), `Ensure ${item.app} in ${config.appDirectory}`)
  })
  return {
    id: `cask:${item.name}`, description: `Ensure ${item.app} in ${config.appDirectory}`, inspect,
    apply: () => Effect.gen(function* () {
      const brew = yield* requireHomebrew(system)
      const recorded = yield* system.run({ file: brew, args: ["list", "--cask", item.name] })
      yield* checked(system, {
        file: brew, args: [recorded.code === 0 ? "reinstall" : "install", "--cask", `--appdir=${config.appDirectory}`, item.name], interactive: true
      })
    }),
    verify: () => verifyObservation(`cask:${item.name}`, inspect)
  }
}

function spotlight(system: System, folders: ReadonlyArray<string>): Resource {
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
      if (paths.length) yield* checked(system, { file: "osascript", args: ["-", ...new Set(paths)], input: spotlightScript })
    }),
    // The AppleScript checks that each picker submission is accepted, then closes the dialog.
    // There is no independent, supported folder-level query for these exclusions.
    verify: () => Effect.void
  }
}

export function resources(system: System, config: Configuration, mise: string): ReadonlyArray<Resource> {
  return [
    appearance(system, config.appearance),
    homebrew(system),
    profileEntry(system, "Homebrew", config.homebrewProfile, () => Effect.gen(function* () {
      const brew = yield* findHomebrew(system)
      return brew ? `eval "$(${quote(brew)} shellenv)"` : undefined
    })),
    profileEntry(system, "mise", config.miseProfile, () => Effect.succeed(`eval "$(${quote(mise)} activate zsh)"`)),
    ...config.casks.map(item => cask(system, config, item)),
    spotlight(system, config.spotlightExcludedFolders)
  ]
}
