import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import type { Configuration } from "../config.ts"
import type { Observation, Resource } from "../runner.ts"
import { verifyObservation } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"
import { gitSettings } from "./git.ts"
import { vlcSettings } from "./vlc.ts"

const spotlightScript = readFileSync(new URL("./spotlight.applescript", import.meta.url), "utf8")
const quote = (text: string) => /^[a-zA-Z0-9_/.+-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
const observation = (ok: boolean, detail: string): Observation => ({ status: ok ? "ok" : "change", detail })

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

function homebrew(system: System, brew: string): Resource {
  const inspect = () => Effect.gen(function* () {
    const installed = yield* system.executable(brew)
    if (installed) yield* checked(system, { file: brew, args: ["--version"] })
    return observation(installed, installed ? `Installed at ${brew}` : "Homebrew must be prepared by bootstrap.sh")
  })
  return {
    id: "homebrew", description: "Verify Homebrew prepared by the launcher", inspect,
    apply: () => Effect.fail(new BootstrapError("Homebrew", "Run bootstrap.sh to prepare Homebrew and the runtime before configuring this machine.")),
    verify: () => verifyObservation("homebrew", inspect)
  }
}

function profileEntry(system: System, id: string, path: string, line: string): Resource {
  const inspect = () => Effect.gen(function* () {
    const text = (yield* system.readText(path)) ?? ""
    return observation(text.split(/\r?\n/u).includes(line), `Ensure ${id} in ${path}`)
  })
  return {
    id, description: `Configure ${id} in ${path}`, inspect,
    apply: () => Effect.gen(function* () {
      const text = (yield* system.readText(path)) ?? ""
      if (!text.split(/\r?\n/u).includes(line)) yield* system.writeText(path, `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n# ${id}\n${line}\n`)
    }),
    verify: () => verifyObservation(id, inspect)
  }
}

function cask(system: System, config: Configuration, item: Configuration["casks"][number], brew: string): Resource {
  const executable = join(config.appDirectory, item.app, item.executable)
  const inspect = () => Effect.gen(function* () {
    return observation(yield* system.executable(executable), `Ensure ${item.app} in ${config.appDirectory}`)
  })
  return {
    id: `cask:${item.name}`, description: `Ensure ${item.app} in ${config.appDirectory}`, inspect,
    apply: () => Effect.gen(function* () {
      const recorded = yield* system.run({ file: brew, args: ["list", "--cask", item.name] })
      yield* checked(system, {
        file: brew, args: [recorded.code === 0 ? "reinstall" : "install", "--cask", `--appdir=${config.appDirectory}`, item.name], interactive: true
      })
    }),
    verify: () => verifyObservation(`cask:${item.name}`, inspect)
  }
}

function zshCompletions(system: System, path: string, mise: string): Resource {
  const directory = join(dirname(dirname(mise)), "share/zsh/site-functions")
  const completion = join(directory, "_mise")
  const start = (name: string) => `# >>> new-machine-2026 ${name} >>>\n`
  const end = (name: string) => `# <<< new-machine-2026 ${name} <<<\n`
  const render = (original: string) => {
    let text = original
    for (const name of ["zsh fpath", "zsh completion init"]) {
      const first = text.indexOf(start(name)), last = text.indexOf(end(name))
      if (first === -1 && last === -1) continue
      if (first === -1 || last < first || text.indexOf(start(name), first + 1) !== -1 || text.indexOf(end(name), last + 1) !== -1) {
        throw new Error(`Incomplete or duplicate managed ${name} block in ${path}`)
      }
      text = text.slice(0, first) + text.slice(last + end(name).length)
    }
    // fpath must precede a framework's compinit; initialize at the end only if needed.
    const header = `${start("zsh fpath")}fpath=(${quote(directory)} $fpath)\n${end("zsh fpath")}`
    const footer = `${start("zsh completion init")}if (( ! $+functions[compdef] )); then\n  autoload -Uz compinit\n  compinit\nfi\nautoload -Uz _mise\ncompdef _mise mise\n${end("zsh completion init")}`
    return `${header}${text}${!text || text.endsWith("\n") ? "" : "\n"}${footer}`
  }
  const desired = () => Effect.gen(function* () {
    if (!(yield* system.readText(completion))) return yield* Effect.fail(new BootstrapError("zsh completions", `Missing ${completion}; repair mise with brew reinstall mise.`))
    const current = (yield* system.readText(path)) ?? ""
    const next = yield* Effect.try({ try: () => render(current), catch: cause => new BootstrapError("zsh completions", cause) })
    return { current, next }
  })
  const inspect = () => Effect.gen(function* () {
    const state = yield* desired()
    return observation(state.current === state.next, `Load Homebrew's mise completion and initialize zsh in ${path}`)
  })
  return {
    id: "zsh-completions", description: `Configure mise zsh completions in ${path}`, inspect,
    apply: () => Effect.gen(function* () {
      const state = yield* desired()
      if (state.current !== state.next) yield* system.writeText(path, state.next)
    }),
    verify: () => verifyObservation("zsh-completions", inspect)
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

export function resources(system: System, config: Configuration, { brew, mise }: { brew: string; mise: string }): ReadonlyArray<Resource> {
  return [
    homebrew(system, brew),
    appearance(system, config.appearance),
    profileEntry(system, "Homebrew", config.homebrewProfile, `eval "$(${quote(brew)} shellenv)"`),
    profileEntry(system, "mise", config.miseProfile, `eval "$(${quote(mise)} activate zsh)"`),
    zshCompletions(system, config.miseProfile, mise),
    gitSettings(system, config.git.autoSetupRemote),
    ...config.casks.map(item => cask(system, config, item, brew)),
    vlcSettings(system, config.vlc),
    spotlight(system, config.spotlightExcludedFolders)
  ]
}
