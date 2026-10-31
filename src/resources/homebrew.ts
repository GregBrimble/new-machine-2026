import { Effect } from "effect"
import type { Configuration } from "../config.ts"
import { verifyObservation } from "../runner.ts"
import type { Resource } from "../runner.ts"
import { BootstrapError, checked } from "../system.ts"
import type { System } from "../system.ts"

type Packages = Pick<Configuration, "formulae" | "casks">

export function homebrewBundle(system: System, config: Packages, brew: string): Resource {
  const input = [...config.formulae.map(name => `brew "${name}"\n`), ...config.casks.map(name => `cask "${name}"\n`)].join("")
  const description = `Ensure Homebrew formulae: ${config.formulae.join(", ") || "none"}; casks: ${config.casks.join(", ") || "none"}`
  const inspect = () => Effect.gen(function* () {
    const result = yield* system.run({ file: brew, args: ["bundle", "check", "--no-upgrade", "--file=-"], input })
    if (result.code !== 0 && result.code !== 1) return yield* Effect.fail(new BootstrapError("Homebrew Bundle", result.stderr || `Check exited with status ${result.code}`))
    return { status: result.code === 0 ? "ok" as const : "change" as const, detail: description }
  })
  return {
    id: "homebrew-bundle", description, inspect,
    apply: () => checked(system, { file: brew, args: ["bundle", "install", "--no-upgrade", "--file=-"], input, interactive: true }).pipe(Effect.asVoid),
    verify: () => verifyObservation("homebrew-bundle", inspect)
  }
}
