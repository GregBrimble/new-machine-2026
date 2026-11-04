import { Effect } from "effect"
import type { Machine } from "../machine.ts"
import type { Observation, Component } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

export interface Packages { formulae: ReadonlyArray<string>; casks: ReadonlyArray<string> }

export function settings(machine: Machine): Packages {
  const shared = { formulae: ["age", "container", "zoxide"], casks: ["ghostty", "spotify", "vlc", "google-chrome"] }
  const personal: Packages = { formulae: [], casks: [] }
  const cloudflare: Packages = { formulae: [], casks: [] }
  const extra = machine.profile === "personal" ? personal : machine.profile === "cloudflare" ? cloudflare : undefined
  return { formulae: [...shared.formulae, ...(extra?.formulae ?? [])], casks: [...shared.casks, ...(extra?.casks ?? [])] }
}


export function homebrewBundle(system: System, config: Packages, brew: string): Component {
  for (const [kind, names] of [["formula", config.formulae], ["cask", config.casks]] as const) {
    for (const name of names) if (!/^[a-z0-9][a-z0-9+@._-]*$/u.test(name)) throw new Error(`Invalid ${kind}: ${name}`)
  }
  const input = [...config.formulae.map(name => `brew "${name}"\n`), ...config.casks.map(name => `cask "${name}"\n`)].join("")
  const description = `Ensure Homebrew formulae: ${config.formulae.join(", ") || "none"}; casks: ${config.casks.join(", ") || "none"}`
  const inspect = () => Effect.gen(function* () {
    const result = yield* system.run({ file: brew, args: ["bundle", "check", "--no-upgrade", "--file=-"], input })
    if (result.code !== 0 && result.code !== 1) return yield* Effect.fail(new BootstrapError("Homebrew Bundle", result.stderr || `Check exited with status ${result.code}`))
    return { status: result.code === 0 ? "ok" as const : "change" as const, detail: description }
  })
  return {
    id: "homebrew-bundle", description, inspect,
    apply: () => checked(system, { file: brew, args: ["bundle", "install", "--no-upgrade", "--file=-"], input, interactive: true }).pipe(Effect.asVoid)
  }
}

const observation = (ok: boolean, detail: string): Observation => ({ status: ok ? "ok" : "change", detail })

export function homebrew(system: System, brew: string): Component {
  const inspect = () => Effect.gen(function* () {
    const installed = yield* system.executable(brew)
    if (installed) yield* checked(system, { file: brew, args: ["--version"] })
    return observation(installed, installed ? `Installed at ${brew}` : "Homebrew must be prepared by bootstrap.sh")
  })
  return {
    id: "homebrew", description: "Verify Homebrew prepared by the launcher", inspect,
    apply: () => Effect.fail(new BootstrapError("Homebrew", "Run bootstrap.sh to prepare Homebrew and the runtime before configuring this machine."))
  }
}
