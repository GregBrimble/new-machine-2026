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
import { downloadsCleanup } from "./downloads.ts"
import { trashSettings } from "./trash.ts"
import { developerDirectories } from "./developer.ts"
import { homebrewBundle } from "./homebrew.ts"
import { configurationCheckout } from "./checkout.ts"
import { gitSigning, gitSigningKey } from "./signing.ts"

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

function zshCompletions(system: System, path: string, mise: string, brew: string, zoxide: boolean): Resource {
  const directory = join(dirname(dirname(mise)), "share/zsh/site-functions")
  const completion = join(directory, "_mise")
  const start = (name: string) => `# >>> new-machine-2026 ${name} >>>\n`
  const end = (name: string) => `# <<< new-machine-2026 ${name} <<<\n`
  const render = (original: string, zoxideBin?: string) => {
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
    const footer = `${start("zsh completion init")}if (( ! $+functions[compdef] )); then\n  autoload -Uz compinit\n  compinit\nfi\nautoload -Uz _mise\ncompdef _mise mise\n${zoxideBin ? `eval "$(${quote(zoxideBin)} init zsh)"\n` : ""}${end("zsh completion init")}`
    return `${header}${text}${!text || text.endsWith("\n") ? "" : "\n"}${footer}`
  }
  const desired = () => Effect.gen(function* () {
    if (!(yield* system.readText(completion))) return yield* Effect.fail(new BootstrapError("zsh completions", `Missing ${completion}; repair mise with brew reinstall mise.`))
    const zoxideBin = zoxide ? join(yield* checked(system, { file: brew, args: ["--prefix", "zoxide"] }), "bin/zoxide") : undefined
    const current = (yield* system.readText(path)) ?? ""
    const next = yield* Effect.try({ try: () => render(current, zoxideBin), catch: cause => new BootstrapError("zsh completions", cause) })
    return { current, next }
  })
  const inspect = () => Effect.gen(function* () {
    const state = yield* desired()
    return observation(state.current === state.next, `Load Homebrew's mise completion${zoxide ? " and zoxide navigation" : ""} and initialize zsh in ${path}`)
  })
  return {
    id: "zsh-completions", description: `Configure zsh completions${zoxide ? " and zoxide navigation" : ""} in ${path}`, inspect,
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
  const component = (resource: Resource, dependencies: string[] = [], interaction: Resource["interaction"] = []): Resource => ({ ...resource, dependencies, interaction })
  return [
    homebrew(system, brew),
    component(appearance(system, config.appearance), [], ["automation"]),
    developerDirectories(system, config.developerDirectory),
    component(configurationCheckout(system, config.checkout), ["homebrew", "developer-directories"]),
    component(profileEntry(system, "Homebrew", config.homebrewProfile, `eval "$(${quote(brew)} shellenv)"`), ["homebrew"]),
    component(profileEntry(system, "mise", config.miseProfile, `eval "$(${quote(mise)} activate zsh)"`), ["homebrew"]),
    component(gitSettings(system, config.git.autoSetupRemote), ["homebrew"]),
    component(gitSigningKey(system, config.git.signing), ["homebrew"], ["terminal"]),
    component(gitSigning(system, config.git.signing), ["git-signing-key"]),
    component(homebrewBundle(system, config, brew), ["homebrew"], ["terminal"]),
    component(zshCompletions(system, config.miseProfile, mise, brew, config.formulae.includes("zoxide")), ["mise", "homebrew-bundle"]),
    component(vlcSettings(system, config.vlc), ["homebrew-bundle"]),
    component(downloadsCleanup(system, config.downloadsCleanup), ["homebrew"]),
    trashSettings(system, config.trash.removeAfter30Days),
    component(spotlight(system, config.spotlightExcludedFolders), ["homebrew", "developer-directories"], ["automation", "accessibility"])
  ]
}
