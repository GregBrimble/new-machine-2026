import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import { configuration, validateConfiguration } from "./config.ts"
import type { Profile } from "./config.ts"
import { resources } from "./resources/index.ts"
import { reconcile } from "./runner.ts"
import type { Mode } from "./runner.ts"
import { liveSystem } from "./system.ts"
import { zshStartupDirectory } from "./zsh.ts"

function options(args: ReadonlyArray<string>): { mode: Mode; profile: Profile } {
  let mode: Mode = "apply", profile: Profile = "shared"
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--dry-run" || arg === "--plan") {
      if (mode !== "apply") throw new Error("Choose only one of --dry-run and --plan.")
      mode = arg === "--plan" ? "plan" : "preview"
    } else if (arg === "--profile") {
      const next = args[++i]
      if (next !== "shared" && next !== "personal" && next !== "cloudflare") throw new Error("Choose profile shared, personal, or cloudflare.")
      profile = next
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return { mode, profile }
}

async function main() {
  const { mode, profile } = options(process.argv.slice(2))
  if (process.platform !== "darwin") throw new Error("This configurator supports macOS only.")
  if (process.getuid?.() === 0) throw new Error("Run as your normal user, without sudo.")
  const mise = process.env.BOOTSTRAP_MISE_BIN
  const brew = process.env.BOOTSTRAP_BREW_BIN
  if (!mise || !isAbsolute(mise) || !brew || !isAbsolute(brew)) throw new Error("Run through bootstrap.sh so Homebrew, mise, and Node.js are prepared.")
  const system = liveSystem(process.env)
  const zshDirectory = await Effect.runPromise(zshStartupDirectory(system))
  const config = configuration(homedir(), zshDirectory, profile)
  validateConfiguration(config)
  console.log(`Profile: ${profile}; mode: ${mode}`)
  await Effect.runPromise(reconcile(resources(system, config, { brew, mise }), mode, console.log))
  if (mode === "preview") console.log("Preview only: configuration was not applied.")
  else if (mode === "plan") console.log("Plan only: machine settings were inspected, without applying changes.")
  else console.log("Configuration applied. Open a new login terminal to pick up Homebrew and mise.")
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
